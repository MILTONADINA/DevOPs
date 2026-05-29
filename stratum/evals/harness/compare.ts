/**
 * Deterministic gating math (Phase 2 / v0.4.x) — the core of the eval gate.
 *
 * Given pruned + baseline metric scores, decide PASS/FAIL per
 * docs/EVAL_FRAMEWORK.md: a metric passes iff (a) its pruned score clears the
 * absolute floor AND (b) its degradation vs the full-context baseline is within
 * tolerance. This file has NO external dependencies (no judge, no datasets) and
 * is fully unit-tested — it is the dataset/judge-agnostic decision logic.
 */

import type { MetricScores, MetricThresholds, ScenarioResult, Tier } from "./types";

/** Per-metric verdict with the numbers that produced it (logged for the report). */
export interface MetricVerdict {
  metric: "faithfulness" | "answerRelevancy";
  prunedScore: number;
  baselineScore: number;
  /** pruned − baseline. Negative ⇒ degradation. */
  delta: number;
  /** Absolute floor this metric had to clear. */
  min: number;
  passed: boolean;
  /** Why it failed (absent when passed). */
  reason?: string;
}

/** A scenario passes iff BOTH metrics pass. */
export interface ScenarioVerdict {
  tier: Tier;
  name: string;
  faithfulness: MetricVerdict;
  answerRelevancy: MetricVerdict;
  passed: boolean;
}

/**
 * Gate a single metric.
 *
 * PASSES iff `prunedScore >= min` (absolute floor — the threshold table states a
 * *minimum* score, so the floor is inclusive) AND `(baseline − pruned) <
 * maxDegradation` (degradation strictly within tolerance).
 *
 * @param metric - which metric this is (for the verdict record).
 * @param prunedScore - score with pruned context.
 * @param baselineScore - score with full context.
 * @param min - absolute floor (e.g. 0.90).
 * @param maxDegradation - max acceptable (baseline − pruned) (e.g. 0.05).
 * @returns the {@link MetricVerdict}.
 */
export function gateMetric(
  metric: "faithfulness" | "answerRelevancy",
  prunedScore: number,
  baselineScore: number,
  min: number,
  maxDegradation: number,
): MetricVerdict {
  const delta = prunedScore - baselineScore;
  const belowFloor = prunedScore < min;
  const degradedTooMuch = baselineScore - prunedScore >= maxDegradation;
  const passed = !belowFloor && !degradedTooMuch;

  const base: MetricVerdict = { metric, prunedScore, baselineScore, delta, min, passed };
  if (passed) return base;

  const reasons: string[] = [];
  if (belowFloor) reasons.push(`below floor (${prunedScore.toFixed(3)} < ${min.toFixed(2)})`);
  if (degradedTooMuch) {
    reasons.push(
      `degradation ${(baselineScore - prunedScore).toFixed(3)} ≥ ${maxDegradation.toFixed(2)} ` +
        `(pruned ${prunedScore.toFixed(3)} vs baseline ${baselineScore.toFixed(3)})`,
    );
  }
  return { ...base, reason: reasons.join("; ") };
}

/**
 * Gate one scenario's two metrics.
 *
 * @param result - the scenario's pruned + baseline scores.
 * @param thresholds - the gate thresholds.
 * @returns the {@link ScenarioVerdict} (passed iff both metrics pass).
 */
export function gateScenario(result: ScenarioResult, thresholds: MetricThresholds): ScenarioVerdict {
  const faithfulness = gateMetric(
    "faithfulness",
    result.pruned.faithfulness,
    result.baseline.faithfulness,
    thresholds.faithfulnessMin,
    thresholds.maxDegradation,
  );
  const answerRelevancy = gateMetric(
    "answerRelevancy",
    result.pruned.answerRelevancy,
    result.baseline.answerRelevancy,
    thresholds.answerRelevancyMin,
    thresholds.maxDegradation,
  );
  return {
    tier: result.tier,
    name: result.name,
    faithfulness,
    answerRelevancy,
    passed: faithfulness.passed && answerRelevancy.passed,
  };
}

/** Degradation delta (pruned − baseline) for both metrics — for compare/report. */
export function scenarioDelta(result: ScenarioResult): MetricScores {
  return {
    faithfulness: result.pruned.faithfulness - result.baseline.faithfulness,
    answerRelevancy: result.pruned.answerRelevancy - result.baseline.answerRelevancy,
  };
}
