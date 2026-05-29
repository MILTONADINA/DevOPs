/**
 * Eval Suite Runner (Phase 2 / v0.4.x).
 *
 * Orchestrates the eval flow (docs/EVAL_FRAMEWORK.md §How the Harness Works):
 * prune → answer(pruned) + answer(full) → judge both → gate → report.
 * `runScenario`/`runSuite` take the Answerer + Judge (metrics.ts) by injection,
 * so they are fully testable with deterministic fakes; the deterministic gate
 * they feed (compare/golden/report) needs neither judge nor datasets.
 *
 * The CLI entry (`main`, invoked by `npm run test:eval`) is GATED: the real
 * datasets (LoCoMo/MT-Bench+/SCM4LLMs + the §2b-derived developer set), the
 * Answerer/Judge implementation, and the ONNX encoder do not exist yet. Rather
 * than fabricate a PASS, it prints exactly what is missing and exits 0 (a
 * documented not-configured state, mirroring the CI red-team bootstrap-skip) —
 * it NEVER prints fake scores.
 *
 * Usage:
 *   npm run test:eval                        # full suite
 *   npm run test:eval -- --fast              # Tier B + C only
 *   npm run test:eval -- --suite kadanedial  # algorithm-specific
 *   npm run test:eval -- --compare-lambda 0.97 0.90
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Answerer, Judge } from "./metrics";
import { judgeConfigured } from "./metrics";
import { gateScenario } from "./compare";
import { checkGoldenQuery } from "./golden";
import { evaluateSuite, renderReport, type SuiteResult, type SuiteVerdict } from "./report";
import { DEFAULT_THRESHOLDS, type GoldenQuery, type MetricThresholds, type ScenarioResult, type Tier } from "./types";

/** A runnable scenario: its full context + how to prune it for the query. */
export interface ScenarioInput {
  tier: Tier;
  name: string;
  query: string;
  /** Full (un-pruned) context text. */
  fullContext: string;
  /** Produce the pruned context text for this query (wraps the pruner). */
  prune: (fullContext: string, query: string) => Promise<string> | string;
}

/**
 * Run one scenario end-to-end: prune, answer both contexts, judge both.
 *
 * @param input - the scenario + its pruning function.
 * @param answerer - generates answers (gated; inject a fake in tests).
 * @param judge - scores answers (gated; inject a fake in tests).
 * @returns the {@link ScenarioResult} (pruned + baseline scores).
 */
export async function runScenario(input: ScenarioInput, answerer: Answerer, judge: Judge): Promise<ScenarioResult> {
  const prunedContext = await input.prune(input.fullContext, input.query);
  const [prunedAnswer, baseAnswer] = await Promise.all([
    answerer.generate(input.query, prunedContext),
    answerer.generate(input.query, input.fullContext),
  ]);
  const [pruned, baseline] = await Promise.all([
    judge.score({ query: input.query, context: prunedContext, answer: prunedAnswer }),
    judge.score({ query: input.query, context: input.fullContext, answer: baseAnswer }),
  ]);
  return { tier: input.tier, name: input.name, pruned, baseline };
}

/** A golden query paired with the pruned context it must be checked against. */
export interface GoldenInput {
  query: GoldenQuery;
  prunedContextText: string;
}

/**
 * Run a full suite: score every scenario, check every golden query, gate, render.
 *
 * @param scenarios - scenario inputs.
 * @param golden - golden queries + their pruned contexts.
 * @param answerer - gated answerer (inject a fake in tests).
 * @param judge - gated judge (inject a fake in tests).
 * @param thresholds - gate thresholds (defaults to EVAL_FRAMEWORK.md values).
 * @returns the suite result + verdict.
 */
export async function runSuite(
  scenarios: ScenarioInput[],
  golden: GoldenInput[],
  answerer: Answerer,
  judge: Judge,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
): Promise<{ result: SuiteResult; verdict: SuiteVerdict }> {
  const scored = await Promise.all(scenarios.map((s) => runScenario(s, answerer, judge)));
  const result: SuiteResult = {
    scenarios: scored.map((r) => gateScenario(r, thresholds)),
    golden: golden.map((g) => checkGoldenQuery(g.prunedContextText, g.query)),
  };
  return { result, verdict: evaluateSuite(result) };
}

/** True if any eval dataset directory holds a real file (not just .gitkeep). */
async function datasetsPresent(datasetsDir: string): Promise<boolean> {
  try {
    const entries = await readdir(datasetsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const files = await readdir(join(datasetsDir, entry.name));
      if (files.some((f) => f !== ".gitkeep")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * CLI entry. GATED — prints what is missing and exits 0; never fakes a PASS.
 *
 * @param argv - CLI args (flags acknowledged; honored once the suite is runnable).
 * @returns process exit code (0 — gated-skip is not a failure).
 */
export async function main(argv: string[] = []): Promise<number> {
  // process.cwd() (not __dirname — undefined under the ESM runtime): `npm run
  // test:eval` always executes from the package root.
  const datasetsDir = join(process.cwd(), "evals", "datasets");
  const haveData = await datasetsPresent(datasetsDir);
  const haveJudge = judgeConfigured();
  const flags = argv.length ? ` (flags seen: ${argv.join(" ")})` : "";

  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  out("CQ Eval Suite — GATED (accuracy run not yet runnable)");
  out("=====================================================");
  out(`  datasets present:  ${haveData ? "yes" : "NO  (only .gitkeep in evals/datasets/*)"}`);
  out(`  judge API key:     ${haveJudge ? "yes" : "NO  (set ANTHROPIC_API_KEY)"}`);
  out(`  Answerer/Judge impl: NO  (evals/harness/metrics.ts factories throw — Phase 2 gated)`);
  out(`  ONNX encoder:      NO  (model artifact absent — see src/pruner/encoder.ts)`);
  out("");
  out("The DETERMINISTIC gate engine (compare / golden / report) IS implemented");
  out("and unit-tested — run `npm test` (test/evals/). To run the ACCURACY suite,");
  out("supply: (1) ANTHROPIC_API_KEY, (2) the Tier-A/B/C datasets, (3) a real");
  out("Answerer+Judge in metrics.ts, (4) the ONNX model for the encoder.");
  out(`Refusing to emit fabricated scores. Exiting 0 (gated, not a failure).${flags}`);
  return 0;
}

// Run only when executed directly (not when imported by tests). Uses argv[1]
// rather than `require.main`/`import.meta` so it is robust across runtimes
// (tsx ESM has no `require`; `import.meta` won't typecheck under module:commonjs)
// and false under vitest (whose argv[1] is the vitest binary, not this file).
const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("runner.ts") || entryPath.endsWith("runner.js")) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
