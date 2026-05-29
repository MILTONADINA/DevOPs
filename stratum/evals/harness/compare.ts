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
  /**
   * DIAGNOSTIC (not a pruning failure): BOTH pruned and baseline are below the
   * floor — the answerer/judge can't meet the bar even at FULL context, so a
   * floor miss here is a task/answerer/judge-quality ceiling, not pruning damage
   * (ADR-0016). Degradation still gates it if pruning made it worse.
   */
  baselineBelowFloor?: boolean;
}

/** Evidence-survival co-gate verdict (ADR-0016 / PB-39); present only for gold-evidence datasets. */
export interface EvidenceVerdict {
  /** Fraction of gold-evidence turns that survived pruning, [0,1]. */
  survival: number;
  /** The floor it had to clear. */
  min: number;
  passed: boolean;
}

/** A scenario passes iff BOTH metrics pass AND (if present) the evidence co-gate passes. */
export interface ScenarioVerdict {
  tier: Tier;
  name: string;
  faithfulness: MetricVerdict;
  answerRelevancy: MetricVerdict;
  /** Evidence-survival co-gate — present only when the scenario carries `evidenceSurvival`. */
  evidence?: EvidenceVerdict;
  passed: boolean;
}

/**
 * Gate a single metric — DEGRADATION-DOMINANT (ADR-0016).
 *
 * The constitution's criterion is "<5% degradation vs the full-context baseline."
 * A metric FAILS iff:
 *   1. degradation exceeds tolerance: `(baseline − pruned) ≥ maxDegradation`; OR
 *   2. pruning DROPPED it below the floor: `pruned < min AND baseline ≥ min`
 *      (the absolute-floor miss is pruning-attributable only when the baseline
 *      itself CLEARED the floor).
 *
 * It does NOT fail as a pruning failure when `pruned < min AND baseline < min` —
 * the answerer/judge can't meet the floor even at full context, so that floor
 * miss is a task/answerer/judge ceiling, recorded as the `baselineBelowFloor`
 * diagnostic (NOT silently dropped). Degradation still gates that case if pruning
 * made it worse. (The floor is inclusive — a *minimum* score, per the threshold
 * table.)
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
  const prunedBelowFloor = prunedScore < min;
  const baselineClearedFloor = baselineScore >= min;
  // Floor miss is pruning's fault ONLY if the baseline cleared the floor.
  const droppedBelowFloor = prunedBelowFloor && baselineClearedFloor;
  // Both below floor ⇒ answerer/judge ceiling, not pruning (diagnostic only).
  const baselineBelowFloor = prunedBelowFloor && !baselineClearedFloor;
  const degradedTooMuch = baselineScore - prunedScore >= maxDegradation;
  const passed = !droppedBelowFloor && !degradedTooMuch;

  const base: MetricVerdict = { metric, prunedScore, baselineScore, delta, min, passed };
  if (baselineBelowFloor) base.baselineBelowFloor = true;
  if (passed) return base;

  const reasons: string[] = [];
  if (droppedBelowFloor) {
    reasons.push(`pruning dropped below floor (pruned ${prunedScore.toFixed(3)} < ${min.toFixed(2)} ≤ baseline ${baselineScore.toFixed(3)})`);
  }
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
  // Evidence-survival co-gate (ADR-0016 / PB-39) — only when the scenario carries
  // a gold-evidence survival value. Deterministic; catches a pruner that drops the
  // evidence but bluffs a plausible answer (which the metrics alone can miss).
  const evidence: EvidenceVerdict | undefined =
    result.evidenceSurvival === undefined
      ? undefined
      : { survival: result.evidenceSurvival, min: thresholds.evidenceSurvivalMin, passed: result.evidenceSurvival >= thresholds.evidenceSurvivalMin };
  const verdict: ScenarioVerdict = {
    tier: result.tier,
    name: result.name,
    faithfulness,
    answerRelevancy,
    passed: faithfulness.passed && answerRelevancy.passed && (evidence?.passed ?? true),
  };
  if (evidence) verdict.evidence = evidence;
  return verdict;
}

/** Degradation delta (pruned − baseline) for both metrics — for compare/report. */
export function scenarioDelta(result: ScenarioResult): MetricScores {
  return {
    faithfulness: result.pruned.faithfulness - result.baseline.faithfulness,
    answerRelevancy: result.pruned.answerRelevancy - result.baseline.answerRelevancy,
  };
}
