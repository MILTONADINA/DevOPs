/**
 * Eval-suite shared types (Phase 2 / v0.4.x).
 *
 * The gating/reporting ENGINE these types feed (compare.ts / golden.ts /
 * report.ts) is deterministic and unit-tested NOW. The metric SOURCE (the
 * LLM-judged Faithfulness/Answer-Relevancy scores) and the DATASETS
 * (LoCoMo/MT-Bench+/SCM4LLMs + the §2b-derived developer set) are gated — see
 * metrics.ts (judge seam) and runner.ts (gated-skip). Thresholds + tiers mirror
 * docs/EVAL_FRAMEWORK.md verbatim.
 */

/** Eval tier per docs/EVAL_FRAMEWORK.md (A = published, B = dev workload, C = golden). */
export type Tier = "A" | "B" | "C";

/** Pass/fail thresholds (docs/EVAL_FRAMEWORK.md §Acceptable Thresholds). */
export interface MetricThresholds {
  /** Faithfulness minimum (0.90). */
  faithfulnessMin: number;
  /** Answer-Relevancy minimum (0.88). */
  answerRelevancyMin: number;
  /** Max acceptable degradation vs the full-context baseline (0.05 = 5%). */
  maxDegradation: number;
}

export const DEFAULT_THRESHOLDS: MetricThresholds = {
  faithfulnessMin: 0.9,
  answerRelevancyMin: 0.88,
  maxDegradation: 0.05,
};

/** The two metrics that matter, for one response (pruned OR baseline). */
export interface MetricScores {
  /** DeepEval FaithfulnessMetric score in [0,1]. */
  faithfulness: number;
  /** DeepEval AnswerRelevancyMetric score in [0,1]. */
  answerRelevancy: number;
}

/** One scenario's pruned-vs-baseline scores (Tier A or B). */
export interface ScenarioResult {
  tier: Tier;
  /** Scenario id, e.g. "LoCoMo" or "func_deprecation". */
  name: string;
  /** Scores with pruned context. */
  pruned: MetricScores;
  /** Scores with full (un-pruned) context — the baseline. */
  baseline: MetricScores;
}

/** A Tier-C golden query: a deterministic must-survive-pruning fact check. */
export interface GoldenQuery {
  id: string;
  scenario: string;
  query: string;
  /** Substrings that MUST appear in the pruned context. */
  expectedContains: string[];
  /** Substrings that must NOT appear in the pruned context. */
  expectedNotContains: string[];
  /** Critical queries must pass 100% — any failure rejects the whole run. */
  critical: boolean;
}

/** Outcome of one golden-query check. */
export interface GoldenResult {
  query: GoldenQuery;
  passed: boolean;
  /** expectedContains entries that were absent (a miss). */
  missing: string[];
  /** expectedNotContains entries that were present (a leak). */
  leaked: string[];
}
