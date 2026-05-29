/**
 * Tier-B accuracy eval (MANUAL — real ONNX model + real Claude API).
 *
 * Loads the synthetic-but-realistic Tier-B dataset
 * (evals/datasets/developer/tier-b.jsonl) and runs each scenario through the
 * REAL pipeline (encode → KadaneDial prune → answer pruned vs full → judge →
 * gate). This is the dev-set accuracy gate for the scenarios CQ is built for;
 * the PUBLISHED benchmarks (LoCoMo/MT-Bench+/SCM4LLMs) are still separate.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:tierb
 */

import { join } from "node:path";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { createClaudeAnswerer, createLlmJudge } from "../evals/harness/metrics";
import { loadDevScenarios } from "../evals/harness/dataset";
import { runDevSuite } from "../evals/harness/dev-suite";
import { renderReport } from "../evals/harness/report";

// Fixed reference time so the dataset's ageHours map deterministically.
const NOW_SECONDS = 1_700_000_000;

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (!process.env["ANTHROPIC_API_KEY"]) {
    out("eval:tierb GATED: set ANTHROPIC_API_KEY (answerer + judge use the real API).");
    return 0;
  }

  const file = join(process.cwd(), "evals", "datasets", "developer", "tier-b.jsonl");
  const scenarios = loadDevScenarios(file);
  out(`Loaded ${scenarios.length} Tier-B scenarios from ${file}.`);
  out("→ encoding (real ONNX) + pruning + answering + judging (real Claude Haiku)…");

  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const { suite, verdict, outcomes } = await runDevSuite(scenarios, encoder, createClaudeAnswerer(), createLlmJudge(), NOW_SECONDS);

  out("");
  out("Per-scenario pruning + scores:");
  for (const o of outcomes) {
    out(
      `  ${o.scenario.id.padEnd(18)} kept [${o.decision.selectedIndices.join(",")}]/${o.scenario.turns.length}  ` +
        `-${o.reductionPct}% ctx  faith ${o.result.pruned.faithfulness}/${o.result.baseline.faithfulness} (pruned/base)  ` +
        `relev ${o.result.pruned.answerRelevancy}/${o.result.baseline.answerRelevancy}`,
    );
  }

  const avgReduction = outcomes.length ? Math.round(outcomes.reduce((a, o) => a + o.reductionPct, 0) / outcomes.length) : 0;
  out("");
  out(renderReport(suite, verdict));
  out("");
  const passCount = suite.scenarios.filter((s) => s.passed).length;
  out(`Summary: ${passCount}/${suite.scenarios.length} scenarios passed; avg context reduction ${avgReduction}%.`);
  out("NOTE: Tier-B is synthetic-but-realistic (EVAL_FRAMEWORK.md). A FAIL here is a real finding (e.g. over-aggressive temporal decay dropping an old-but-valid decision) → tune λ/θ, do NOT enable pruning in the request path.");
  return verdict.passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-tierb.ts") || entryPath.endsWith("eval-tierb.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
