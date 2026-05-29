/**
 * Suite verdict + report rendering (Phase 2 / v0.4.x) — deterministic.
 *
 * Aggregates the per-scenario gate verdicts + golden-query results into a single
 * PASS/FAIL with reasons, and renders the text report in the format shown in
 * docs/EVAL_FRAMEWORK.md §Output Format. Pure function of its inputs — no judge,
 * no datasets — fully unit-tested.
 *
 * Gate: the suite PASSES iff every scenario passes AND zero CRITICAL golden
 * queries fail. Non-critical golden misses are surfaced in the pass-rate but do
 * not by themselves fail the run (critical queries are the hard 100% gate).
 */

import type { ScenarioVerdict } from "./compare";
import type { GoldenResult, Tier } from "./types";
import { criticalFailures } from "./golden";

export interface SuiteResult {
  scenarios: ScenarioVerdict[];
  golden: GoldenResult[];
}

export interface SuiteVerdict {
  passed: boolean;
  /** Human-readable failure reasons (empty when passed). */
  failures: string[];
  criticalGoldenFailures: number;
  goldenPassed: number;
  goldenTotal: number;
  /** Suggested remediation (absent when passed). */
  actionRequired?: string;
}

const TIER_LABEL: Record<Tier, string> = {
  A: "Tier A — Published Benchmarks",
  B: "Tier B — Developer Workload",
  C: "Tier C — Golden Queries",
};

/** Aggregate scenario + golden verdicts into a single suite verdict. */
export function evaluateSuite(result: SuiteResult): SuiteVerdict {
  const failures: string[] = [];

  for (const s of result.scenarios) {
    if (s.passed) continue;
    const parts: string[] = [];
    if (!s.faithfulness.passed) parts.push(`Faithfulness ${s.faithfulness.reason ?? "failed"}`);
    if (!s.answerRelevancy.passed) parts.push(`AnswerRelevancy ${s.answerRelevancy.reason ?? "failed"}`);
    failures.push(`${s.name}: ${parts.join("; ")}`);
  }

  for (const g of result.golden) {
    if (!g.query.critical || g.passed) continue;
    const why: string[] = [];
    if (g.missing.length) why.push(`missing [${g.missing.join(", ")}]`);
    if (g.leaked.length) why.push(`leaked [${g.leaked.join(", ")}]`);
    failures.push(`golden ${g.query.id} (critical): ${why.join("; ")}`);
  }

  const criticalGoldenFailures = criticalFailures(result.golden);
  const goldenTotal = result.golden.length;
  const goldenPassed = result.golden.filter((g) => g.passed).length;
  const passed = failures.length === 0;

  const verdict: SuiteVerdict = { passed, failures, criticalGoldenFailures, goldenPassed, goldenTotal };
  if (!passed) verdict.actionRequired = deriveAction(result);
  return verdict;
}

/** Derive a DIRECTION-AWARE remediation hint (missing fact vs leaked noise differ). */
function deriveAction(result: SuiteResult): string {
  const missing = result.golden.filter((g) => g.query.critical && !g.passed && g.missing.length > 0).map((g) => g.query.id);
  const leaked = result.golden.filter((g) => g.query.critical && !g.passed && g.leaked.length > 0).map((g) => g.query.id);
  const hints: string[] = [];
  if (missing.length) {
    hints.push(`[${missing.join(", ")}] a REQUIRED fact was DROPPED (pruning too aggressive) → LOWER θ or RAISE λ (less time decay) / pin the fact`);
  }
  if (leaked.length) {
    hints.push(`[${leaked.join(", ")}] a must-drop turn was KEPT (over-retention) → if it sits in a contiguous span next to the answer, θ/λ tuning will NOT help (sweep-params confirms raising θ drops needed facts); needs a per-turn relevance filter inside spans and/or supersession detection`);
  }
  if (hints.length) return hints.join("; ");
  const firstFail = result.scenarios.find((s) => !s.passed);
  if (firstFail) {
    const metric = !firstFail.faithfulness.passed ? "Faithfulness" : "Answer Relevancy";
    return `${firstFail.name} below ${metric} threshold — widen the context window for this scenario or tune θ.`;
  }
  return "Review failing scenarios and tune θ / λ.";
}

function fmt(n: number): string {
  return n.toFixed(3);
}

/** Render the text report in the docs/EVAL_FRAMEWORK.md output format. */
export function renderReport(result: SuiteResult, verdict: SuiteVerdict): string {
  const lines: string[] = ["CQ Eval Suite v1.0", "=================="];

  for (const tier of ["A", "B"] as const) {
    const inTier = result.scenarios.filter((s) => s.tier === tier);
    if (inTier.length === 0) continue;
    lines.push("", TIER_LABEL[tier]);
    const width = Math.max(...inTier.map((s) => s.name.length));
    for (const s of inTier) {
      const mark = s.passed ? "✓" : "✗";
      const flag = s.passed ? "" : "  ← BELOW THRESHOLD";
      lines.push(
        `  ${s.name.padEnd(width)}  Faithfulness: ${fmt(s.faithfulness.prunedScore)}  ` +
          `AnswerRelevancy: ${fmt(s.answerRelevancy.prunedScore)}  ${mark}${flag}`,
      );
    }
  }

  if (result.golden.length > 0) {
    lines.push("", TIER_LABEL.C);
    const goldenMark = verdict.criticalGoldenFailures === 0 ? "✓" : "✗";
    lines.push(
      `  ${verdict.goldenPassed}/${verdict.goldenTotal} passed  ` +
        `(${verdict.criticalGoldenFailures} critical failures)  ${goldenMark}`,
    );
  }

  lines.push("");
  if (verdict.passed) {
    lines.push("RESULT: PASS — all scenarios within threshold; no critical golden failures.");
  } else {
    lines.push(`RESULT: FAIL — ${verdict.failures.length} failure(s):`);
    for (const f of verdict.failures) lines.push(`  • ${f}`);
    if (verdict.actionRequired) lines.push(`Action required: ${verdict.actionRequired}`);
  }
  return lines.join("\n");
}
