/**
 * Eval Suite Runner (Phase 2 / v0.4.x).
 *
 * Orchestrates the eval flow (docs/EVAL_FRAMEWORK.md §How the Harness Works):
 * prune → answer(pruned) + answer(full) → judge both → gate → report.
 * `runScenario`/`runSuite` take the Answerer + Judge (metrics.ts) by injection,
 * so they are fully testable with deterministic fakes; the deterministic gate
 * they feed (compare/golden/report) needs neither judge nor datasets.
 *
 * The CLI entry runs Tier-C, judged Tier-B, then both full published Tier-A
 * gates. It exits nonzero when any required gate is missing or red.
 *
 * Usage:
 *   npm run test:eval                        # full suite
 *   npm run test:eval -- --fast              # Tier B + C only
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Answerer, Judge } from "./metrics";
import { selectEvalProvider, createClaudeAnswerer, createLlmJudge } from "./metrics";
import { gateScenario } from "./compare";
import { checkGoldenQuery } from "./golden";
import { evaluateSuite, renderReport, type SuiteResult, type SuiteVerdict } from "./report";
import { DEFAULT_THRESHOLDS, type GoldenQuery, type MetricThresholds, type ScenarioResult, type Tier } from "./types";
import { loadDevScenarios } from "./dataset";
import { createOnnxEncoder } from "../../src/pruner/encoder";
import { main as runTierCMain } from "../../scripts/eval-tierc";

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
 * dataset + a judged provider are present. Tier-C always runs first; absent
 * inputs and failing gates exit nonzero. `--fast` covers Tier-B and Tier-C;
 * default full mode also requires both published Tier-A gates.
 *
 * @param argv - CLI args (only --fast is supported).
 * @returns process exit code.
 */
export async function main(argv: string[] = [], runTierC: () => Promise<number> = runTierCMain): Promise<number> {
  // process.cwd() (not __dirname — undefined under the ESM runtime): `npm run
  // test:eval` always executes from the package root.
  const datasetsDir = join(process.cwd(), "evals", "datasets");
  const tierbFile = join(datasetsDir, "developer", "tier-b.jsonl");
  const haveData = await datasetsPresent(datasetsDir);
  const flags = argv.length ? ` (flags: ${argv.join(" ")})` : "";

  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  if (argv.length > 0 && !(argv.length === 1 && argv[0] === "--fast")) {
    out(`Unsupported eval flags: ${argv.join(" ")}. Only --fast is implemented.`);
    return 1;
  }

  const tierCCode = await runTierC();
  if (tierCCode !== 0) {
    out("Tier-C critical golden gate failed; judged evaluation was not run.");
    return 1;
  }
  let provider: ReturnType<typeof selectEvalProvider>;
  try {
    provider = selectEvalProvider();
  } catch (error) {
    out(`eval provider error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (haveData && provider) {
    out(`CQ Eval Suite — Tier-B (real ONNX encoder + ${provider.label} judge${provider.exploratory ? "; exploratory local-model result" : ""})${flags}`);
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
      const { suite, verdict } = await runDevSuite(scenarios, encoder, createClaudeAnswerer(provider.completion), createLlmJudge(provider.completion), EVAL_NOW_SECONDS);
      if (suite.scenarios.length === 0) {
        out("Tier-B produced zero scored scenarios; refusing a vacuous full-suite pass.");
        return 1;
      }
      out(renderReport(suite, verdict));
      out(`\n${verdict.passed ? "PASS" : "FAIL"} — ${suite.scenarios.filter((s) => s.passed).length}/${suite.scenarios.length} Tier-B scenarios; Tier-C passed.`);
      if (provider.exploratory) out("Local-model judgment is exploratory and does not satisfy the Claude release gate.");
      if (!verdict.passed) return 1;
      if (argv.includes("--fast")) return provider.exploratory ? 1 : 0;

      const priorFull = process.env["EVAL_FULL_PUBLISHED"];
      process.env["EVAL_FULL_PUBLISHED"] = "1";
      let gate = "LoCoMo";
      try {
        const { main: runLocomo } = await import("../../scripts/eval-locomo");
        const locomoCode = await runLocomo();
        if (locomoCode !== 0) {
          out("Full eval failed: LoCoMo Tier-A gate did not pass.");
          return 1;
        }
        gate = "LongMemEval";
        const { main: runLongMemEval } = await import("../../scripts/eval-longmemeval");
        const longMemCode = await runLongMemEval();
        if (longMemCode !== 0) {
          out("Full eval failed: LongMemEval Tier-A gate did not pass.");
          return 1;
        }
      } catch (error) {
        out(`${gate} Tier-A gate errored: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      } finally {
        if (priorFull === undefined) delete process.env["EVAL_FULL_PUBLISHED"];
        else process.env["EVAL_FULL_PUBLISHED"] = priorFull;
      }
      if (provider.exploratory) {
        out("Exploratory full eval completed; release gate remains open.");
        return 1;
      }
      out("Full eval: Tier-C, Tier-B, LoCoMo, and LongMemEval passed.");
      return 0;
    } catch (e) {
      out(`eval run errored: ${(e as Error).message}`);
      return 1;
    }
  }

  // A missing judged input is a failed gate, not a successful skip.
  out("CQ Eval Suite — GATED (an input is missing; not run)");
  out("====================================================");
  out(`  Tier-B dataset:  ${haveData ? "yes" : "NO  (evals/datasets/developer/tier-b.jsonl)"}`);
  out(`  judged provider: ${provider ? provider.label : "NO (set EVAL_ANTHROPIC_API_KEY or explicit local eval settings)"}`);
  out("Tier-C ran, but Tier-B judged evaluation cannot run. Exiting 1.");
  return 1;
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
