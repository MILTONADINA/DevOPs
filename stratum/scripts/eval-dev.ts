/**
 * End-to-end pruner eval on a SYNTHETIC dev set (MANUAL — real model + real API).
 *
 * Exercises the WHOLE v0.4.x pipeline on real components: real ONNX embeddings →
 * KadaneDial prune() → real Claude answerer on pruned vs full context → real LLM
 * judge → the deterministic gate. This is the dev-set proxy for the accuracy gate
 * (docs/EVAL_FRAMEWORK.md); the PUBLISHED-benchmark numbers still require the
 * Tier-A datasets (LoCoMo/MT-Bench+/SCM4LLMs). It proves the pipeline is wired
 * correctly + that the pruner keeps the answer-critical turn.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:dev   (first run downloads the model)
 */

import { join } from "node:path";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL } from "../src/pruner/kadanedial";
import { createClaudeAnswerer, createLlmJudge } from "../evals/harness/metrics";
import { runScenario, type ScenarioInput } from "../evals/harness/runner";
import { gateScenario } from "../evals/harness/compare";
import { checkGoldenQuery } from "../evals/harness/golden";
import { evaluateSuite, renderReport, type SuiteResult } from "../evals/harness/report";
import { DEFAULT_THRESHOLDS } from "../evals/harness/types";

const NOW = 1_700_000_000;
// Synthetic dev dialogue: one answer-critical turn (the DB decision) buried in
// unrelated chatter. A correct pruner KEEPS turn 1 and drops the noise.
const TURNS: { text: string; ts: number }[] = [
  { text: "Let's kick off the project. Can you set up the repo scaffolding?", ts: NOW - 7 * 120 },
  { text: "Decision: we migrated the database from Postgres to Supabase; the client library is @supabase/supabase-js.", ts: NOW - 6 * 120 },
  { text: "The login button's CSS is off — the padding looks too tight on mobile.", ts: NOW - 5 * 120 },
  { text: "Please reformat the README and fix the markdown table alignment.", ts: NOW - 4 * 120 },
  { text: "There's a flaky unit test in the date-formatting helper; bump the timeout.", ts: NOW - 3 * 120 },
  { text: "Add a tooltip to the settings icon in the navbar.", ts: NOW - 2 * 120 },
  { text: "Rename the util file from helpers.ts to format-utils.ts.", ts: NOW - 1 * 120 },
];
const QUERY = "Which database did we decide to use, and what client library?";

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (!process.env["ANTHROPIC_API_KEY"]) {
    out("eval:dev GATED: set ANTHROPIC_API_KEY (answerer + judge use the real API).");
    return 0;
  }

  out("→ encoding the dev dialogue with the real ONNX encoder…");
  const enc = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const histVecs = await enc.encode(TURNS.map((t) => t.text));
  const [queryVec] = await enc.encode([QUERY]);
  if (!queryVec) {
    out("FAIL: query did not encode.");
    return 1;
  }
  const history: HistoryEmbedding[] = TURNS.map((t, i) => ({ embedding: histVecs[i]!, timestampSeconds: t.ts }));

  const decision = prune(queryVec, history, { ...DEFAULT_KADANEDIAL, nowSeconds: NOW });
  const prunedText = decision.selectedIndices.map((i) => TURNS[i]!.text).join("\n");
  const fullText = TURNS.map((t) => t.text).join("\n");

  out("");
  out(`Pruner kept turns [${decision.selectedIndices.join(", ")}] of ${TURNS.length}; pruned [${decision.prunedIndices.join(", ")}].`);
  out(`Context size: full ${fullText.length} chars → pruned ${prunedText.length} chars (${Math.round((1 - prunedText.length / fullText.length) * 100)}% smaller).`);

  out("→ answering pruned vs full context + judging (real Claude Haiku)…");
  const scenario: ScenarioInput = {
    tier: "B",
    name: "dev_decision_recall",
    query: QUERY,
    fullContext: fullText,
    prune: () => prunedText, // already computed by the real pruner above
  };
  const result = await runScenario(scenario, createClaudeAnswerer(), createLlmJudge());
  const scenarioVerdict = gateScenario(result, DEFAULT_THRESHOLDS);

  const golden = [
    checkGoldenQuery(prunedText, {
      id: "gc-dev-1",
      scenario: "dev_decision_recall",
      query: QUERY,
      expectedContains: ["Supabase"],
      expectedNotContains: [],
      critical: true,
    }),
  ];
  const suite: SuiteResult = { scenarios: [scenarioVerdict], golden };
  const verdict = evaluateSuite(suite);

  out("");
  out(renderReport(suite, verdict));
  out("");
  out(`(pruned scores: faithfulness=${result.pruned.faithfulness} relevancy=${result.pruned.answerRelevancy}; ` +
    `baseline: faithfulness=${result.baseline.faithfulness} relevancy=${result.baseline.answerRelevancy})`);
  out("NOTE: synthetic dev set — proves the pipeline + pruner selection; published-benchmark numbers need the Tier-A datasets.");
  return verdict.passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-dev.ts") || entryPath.endsWith("eval-dev.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
