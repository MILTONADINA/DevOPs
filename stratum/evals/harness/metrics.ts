/**
 * Metric sources — the LLM-as-judge implementation (Phase 2 / v0.4.x).
 *
 * docs/EVAL_FRAMEWORK.md's flow needs two model calls per scenario: an
 * "answerer" (Claude Haiku given a context + query → an answer) and a "judge"
 * (Faithfulness + Answer-Relevancy scoring of that answer). DeepEval is a Python
 * lib; this is the TS LLM-as-judge equivalent — one structured judge call
 * returning both scores.
 *
 * Both the answerer and the judge are built on an injectable {@link LlmCompletion}
 * seam. The DEFAULT is the real Claude SDK (so `npm run test:eval` / smoke uses
 * the real model once a key + datasets exist); tests inject a deterministic fake
 * so the prompt-building + score PARSING/CLAMPING is verified with NO API call
 * and NO fabricated scores. Without a key the real seam throws (still gated by
 * key); the score parser never invents a number.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MetricScores } from "./types";

/** Single-shot text completion — the one LLM primitive the answerer + judge need. */
export interface LlmCompletion {
  /**
   * @param prompt - the full user prompt.
   * @param opts - optional max output tokens.
   * @returns the model's text output.
   */
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

/** Generates an answer for a (query, context) pair. */
export interface Answerer {
  /**
   * @param query - the user query under test.
   * @param context - the context to answer from (pruned OR full baseline).
   * @returns the model's answer text.
   */
  generate(query: string, context: string): Promise<string>;
}

/** Scores an answer's Faithfulness + Answer-Relevancy. */
export interface Judge {
  /**
   * @param input - the query, the context the answer was produced from, and the answer.
   * @returns the {@link MetricScores} (faithfulness + answerRelevancy in [0,1]).
   */
  score(input: { query: string; context: string; answer: string }): Promise<MetricScores>;
}

export interface LlmOptions {
  /** API key; falls back to ANTHROPIC_API_KEY. */
  apiKey?: string | undefined;
  /** Judge/answerer model (EVAL_FRAMEWORK.md uses Claude Haiku for cost stability). */
  model?: string | undefined;
}

const NO_KEY =
  "eval metric source needs an API key: set ANTHROPIC_API_KEY (or pass opts.apiKey). " +
  "The judge uses Claude Haiku per docs/EVAL_FRAMEWORK.md. Refusing to fabricate scores.";

const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5-20251001";

/** Real Claude-SDK completion. Lazily reads the key so construction never throws. */
export function createClaudeCompletion(opts: LlmOptions = {}): LlmCompletion {
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  return {
    async complete(prompt, callOpts): Promise<string> {
      const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new Error(NO_KEY);
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model,
        max_tokens: callOpts?.maxTokens ?? 512,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

function answerPrompt(query: string, context: string): string {
  return (
    "Answer the QUERY using ONLY the information in the CONTEXT. If the context " +
    "does not contain the answer, say so briefly. Be concise.\n\n" +
    `CONTEXT:\n${context}\n\nQUERY:\n${query}`
  );
}

function judgePrompt(query: string, context: string, answer: string): string {
  return (
    "You are a strict evaluation judge. Score the ANSWER on two metrics, each a " +
    "float from 0.0 to 1.0:\n" +
    "- faithfulness: are ALL factual claims in the ANSWER supported by the CONTEXT? " +
    "Penalize any claim that contradicts or is absent from the CONTEXT. " +
    "1.0 = fully grounded, 0.0 = hallucinated or contradicted.\n" +
    "- answer_relevancy: does the ANSWER directly and completely address the QUERY? " +
    "1.0 = fully relevant and complete, 0.0 = off-topic or empty.\n" +
    'Respond with ONLY a JSON object: {"faithfulness": <float>, "answer_relevancy": <float>, "reason": "<one short sentence>"}\n\n' +
    `QUERY:\n${query}\n\nCONTEXT:\n${context}\n\nANSWER:\n${answer}`
  );
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse the judge's JSON reply into clamped scores. Throws (never invents a
 * number) if the reply has no parseable {faithfulness, answer_relevancy}.
 *
 * @param raw - the judge model's raw text output.
 * @returns the {@link MetricScores}.
 * @throws {Error} if the scores cannot be parsed.
 */
export function parseJudgeScores(raw: string): MetricScores {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge reply has no JSON object: ${raw.slice(0, 120)}`);
  let obj: { faithfulness?: unknown; answer_relevancy?: unknown; answerRelevancy?: unknown };
  try {
    obj = JSON.parse(match[0]) as typeof obj;
  } catch {
    throw new Error(`judge reply is not valid JSON: ${match[0].slice(0, 120)}`);
  }
  const f = obj.faithfulness;
  const a = obj.answer_relevancy ?? obj.answerRelevancy;
  if (typeof f !== "number" || typeof a !== "number") {
    throw new Error(`judge reply missing numeric faithfulness/answer_relevancy: ${match[0].slice(0, 120)}`);
  }
  return { faithfulness: clamp01(f), answerRelevancy: clamp01(a) };
}

/**
 * Create the Claude-Haiku answerer.
 *
 * @param llm - the completion seam (defaults to the real Claude SDK).
 * @returns an {@link Answerer}.
 */
export function createClaudeAnswerer(llm: LlmCompletion = createClaudeCompletion()): Answerer {
  return {
    generate(query, context): Promise<string> {
      return llm.complete(answerPrompt(query, context), { maxTokens: 1024 });
    },
  };
}

/**
 * Create the LLM-as-judge (faithfulness + answer-relevancy).
 *
 * @param llm - the completion seam (defaults to the real Claude SDK).
 * @returns a {@link Judge}.
 */
export function createLlmJudge(llm: LlmCompletion = createClaudeCompletion()): Judge {
  return {
    async score({ query, context, answer }): Promise<MetricScores> {
      const raw = await llm.complete(judgePrompt(query, context, answer), { maxTokens: 256 });
      return parseJudgeScores(raw);
    },
  };
}

/** True when an API key is available to drive the real metric sources. */
export function judgeConfigured(opts: LlmOptions = {}): boolean {
  return Boolean(opts.apiKey ?? process.env["ANTHROPIC_API_KEY"]);
}
