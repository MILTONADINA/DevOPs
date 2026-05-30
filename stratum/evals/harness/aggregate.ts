/**
 * Repeat-and-average noise damping for judged metric scores (PB-42 / ADR-0015).
 *
 * The LLM judge + answerer are stochastic: ADR-0015's N=18 LoCoMo run saw baseline
 * Answer-Relevancy swing across the whole [0,1] range, so a single sample per
 * scenario is too noisy to certify a <5%-degradation ship decision. The fix is to
 * score each context R times and AVERAGE (the caller drives R repeats via
 * scoreContextRepeated; this module reduces the samples).
 *
 * Pure + dependency-free: no judge, no API, no datasets — fully unit-tested. The
 * mechanism is free to build and run with fakes; only the REAL R× scoring costs
 * R× credits, an explicit precision/credit knob.
 */

import type { MetricScores } from "./types";

/** A scenario's score summarized over R judge samples. */
export interface ScoreSummary {
  /** Per-metric mean over the samples (the noise-damped point estimate the gate uses). */
  mean: MetricScores;
  /**
   * Per-metric SAMPLE standard deviation (Bessel-corrected, ÷(n−1)) — the judge
   * noise. 0 when fewer than 2 samples (a single shot has no measurable spread).
   * Surfaced in the report so a reader can tell whether R was large enough to trust
   * the mean (a wide std at the ship gate means more repeats are needed).
   */
  std: MetricScores;
  /** How many samples produced this summary (R). */
  samples: number;
}

function sampleStd(xs: number[], mean: number): number {
  if (xs.length < 2) return 0; // one sample → no measurable spread (not NaN)
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Summarize R judge samples of ONE context into a mean + sample-std per metric.
 *
 * @param scores - the R samples (each {faithfulness, answerRelevancy}); must be non-empty.
 * @returns the {@link ScoreSummary} (mean is the point estimate the gate consumes; std is the noise).
 * @throws {Error} if given zero samples (a ship gate must never average nothing into a silent 0).
 */
export function summarizeScores(scores: MetricScores[]): ScoreSummary {
  if (scores.length === 0) {
    throw new Error("summarizeScores: need at least one sample (refusing to invent a zero score)");
  }
  const n = scores.length;
  const faith = scores.map((s) => s.faithfulness);
  const relev = scores.map((s) => s.answerRelevancy);
  const meanF = faith.reduce((a, b) => a + b, 0) / n;
  const meanA = relev.reduce((a, b) => a + b, 0) / n;
  return {
    mean: { faithfulness: meanF, answerRelevancy: meanA },
    std: { faithfulness: sampleStd(faith, meanF), answerRelevancy: sampleStd(relev, meanA) },
    samples: n,
  };
}
