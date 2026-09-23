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
import { judgeConfigured, createClaudeAnswerer, createLlmJudge } from "./metrics";
import { gateScenario } from "./compare";
import { checkGoldenQuery } from "./golden";
import { evaluateSuite, renderReport, type SuiteResult, type SuiteVerdict } from "./report";
import { DEFAULT_THRESHOLDS, type GoldenQuery, type MetricThresholds, type ScenarioResult, type Tier } from "./types";
import { loadDevScenarios } from "./dataset";
import { createOnnxEncoder } from "../../src/pruner/encoder";

// Fixed reference time so the Tier-B dataset's ageHours map deterministically.
const EVAL_NOW_SECONDS = 1_700_000_000;

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
 * CLI entry (`npm run test:eval`). Runs the real Tier-B accuracy suite when the
 * dataset + an API key are present; otherwise prints exactly what is missing and
 * exits 0 (gated-skip, never a fake PASS). Returns 1 if the real suite fails.
 *
 * @param argv - CLI args (flags acknowledged).
 * @returns process exit code (real-run: verdict.passed ? 0 : 1; gated: 0).
 */
export async function main(argv: string[] = []): Promise<number> {
  // process.cwd() (not __dirname — undefined under the ESM runtime): `npm run
  // test:eval` always executes from the package root.
  const datasetsDir = join(process.cwd(), "evals", "datasets");
  const tierbFile = join(datasetsDir, "developer", "tier-b.jsonl");
  const haveData = await datasetsPresent(datasetsDir);
  const haveJudge = judgeConfigured();
  const flags = argv.length ? ` (flags: ${argv.join(" ")})` : "";

  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  if (haveData && haveJudge) {
    out(`CQ Eval Suite — Tier-B (real ONNX encoder + Claude Haiku judge)${flags}`);
    out("=".repeat(60));
    try {
      // Dynamic import breaks the static runner↔dev-suite cycle (dev-suite
      // imports runScenario from here).
      const { runDevSuite } = await import("./dev-suite");
      const scenarios = loadDevScenarios(tierbFile);
      // FAIL-CLOSED: a present-but-EMPTY/whitespace dataset would otherwise run 0 scenarios → an empty
      // suite passes vacuously ("PASS — 0/0") and a ship gate goes green having evaluated NOTHING. The
      // harness refuses to fabricate scores; an empty dataset is a non-run error, not a pass.
      if (scenarios.length === 0) {
        out("eval run errored: dataset present but contained 0 scenarios (empty/whitespace tier-b.jsonl) — refusing to PASS on nothing.");
        return 1;
      }
      const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
      const { suite, verdict } = await runDevSuite(scenarios, encoder, createClaudeAnswerer(), createLlmJudge(), EVAL_NOW_SECONDS);
      out(renderReport(suite, verdict));
      out(`\n${verdict.passed ? "PASS" : "FAIL"} — ${suite.scenarios.filter((s) => s.passed).length}/${suite.scenarios.length} scenarios. (Tier-B dev set; published Tier-A benchmarks still required before shipping pruning.)`);
      return verdict.passed ? 0 : 1;
    } catch (e) {
      out(`eval run errored: ${(e as Error).message}`);
      return 1;
    }
  }

  // Gated-skip: an input is genuinely missing. Honest probes (no hardcoded NO).
  out("CQ Eval Suite — GATED (an input is missing; not run)");
  out("====================================================");
  out(`  Tier-B dataset:  ${haveData ? "yes" : "NO  (evals/datasets/developer/tier-b.jsonl)"}`);
  out(`  judge API key:   ${haveJudge ? "yes" : "NO  (set ANTHROPIC_API_KEY)"}`);
  out("The gate engine + LLM judge + dataset loader + ONNX encoder are all");
  out("implemented + unit-tested (npm test). Supply the missing input above to run");
  out(`the real Tier-B accuracy eval. Refusing to emit fabricated scores. Exiting 0.`);
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
