/**
 * Metric sources — the LLM-judged seam (Phase 2 / v0.4.x). GATED.
 *
 * docs/EVAL_FRAMEWORK.md's flow needs TWO model calls per scenario: an
 * "answerer" (Claude Haiku given a context + query → an answer) and a "judge"
 * (DeepEval FaithfulnessMetric / AnswerRelevancyMetric scoring that answer).
 * Both are gated on an API key (the user supplies it at test time) AND on the
 * real metric implementation (DeepEval is a Python lib; the TS path is
 * LLM-as-judge prompt engineering validated against the DyCP paper numbers).
 *
 * This file defines the INTERFACES (so the runner + tests are written against a
 * stable seam) and gated factories that THROW until configured — never fake
 * scores. Inject a real Answerer/Judge (or a deterministic fake, as the tests
 * do) to run. The deterministic gate that consumes these scores (compare.ts)
 * needs neither and is fully tested now.
 */

import type { MetricScores } from "./types";

/** Generates an answer for a (query, context) pair. Real impl: Claude Haiku. */
export interface Answerer {
  /**
   * @param query - the user query under test.
   * @param context - the context to answer from (pruned OR full baseline).
   * @returns the model's answer text.
   */
  generate(query: string, context: string): Promise<string>;
}

/** Scores an answer's Faithfulness + Answer-Relevancy. Real impl: DeepEval. */
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

const GATED =
  "eval metric source is GATED (Phase 2): provide ANTHROPIC_API_KEY and a real " +
  "Answerer/Judge implementation (Claude Haiku answerer + DeepEval-style " +
  "Faithfulness/Answer-Relevancy judge per docs/EVAL_FRAMEWORK.md). Refusing to " +
  "fabricate scores. Inject a Judge/Answerer via DI to run.";

/**
 * Create the real Claude-Haiku answerer. GATED — see file header.
 *
 * @param _opts - api key + model.
 * @returns an {@link Answerer}.
 */
export function createClaudeAnswerer(_opts: LlmOptions = {}): Answerer {
  return {
    generate(): Promise<string> {
      return Promise.reject(new Error(GATED));
    },
  };
}

/**
 * Create the real DeepEval-style judge. GATED — see file header.
 *
 * @param _opts - api key + model.
 * @returns a {@link Judge}.
 */
export function createLlmJudge(_opts: LlmOptions = {}): Judge {
  return {
    score(): Promise<MetricScores> {
      return Promise.reject(new Error(GATED));
    },
  };
}

/** True when an API key is available to configure the gated metric sources. */
export function judgeConfigured(opts: LlmOptions = {}): boolean {
  return Boolean(opts.apiKey ?? process.env["ANTHROPIC_API_KEY"]);
}
