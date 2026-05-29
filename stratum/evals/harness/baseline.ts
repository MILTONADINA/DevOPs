/**
 * Full-context baseline runner (Phase 2 / v0.4.x).
 *
 * Scores a scenario's response using the COMPLETE (un-pruned) context — the
 * baseline that pruned scores are compared against (compare.ts). Kept separate
 * from the pruned path on purpose: the baseline is independent of the pruning
 * parameters (λ/g/θ), so it is computed once and REUSED across a parameter
 * sweep (e.g. `--compare-lambda 0.97 0.90`) instead of re-scored each time.
 *
 * Gated on the Answerer + Judge (metrics.ts); fully testable with injected fakes.
 */

import type { Answerer, Judge } from "./metrics";
import type { MetricScores } from "./types";

export interface BaselineScenario {
  name: string;
  query: string;
  /** The full (un-pruned) context text. */
  fullContext: string;
}

/**
 * Score one scenario at full context.
 *
 * @param scenario - the scenario (name + query + full context).
 * @param answerer - produces the answer from the full context.
 * @param judge - scores that answer's faithfulness + answer-relevancy.
 * @returns the baseline {@link MetricScores}.
 */
export async function scoreBaseline(
  scenario: BaselineScenario,
  answerer: Answerer,
  judge: Judge,
): Promise<MetricScores> {
  const answer = await answerer.generate(scenario.query, scenario.fullContext);
  return judge.score({ query: scenario.query, context: scenario.fullContext, answer });
}
