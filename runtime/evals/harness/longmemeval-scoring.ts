/** Offline-testable repeated scoring for LongMemEval's full and pruned contexts. */

import { scoreContextRepeated, type Answerer, type Judge } from "./metrics";
import { summarizeScores, type ScoreSummary } from "./aggregate";

/** Score both contexts R times; the caller gates on each summary's mean. */
export async function scoreLongMemContexts(
  query: string,
  fullContext: string,
  prunedContext: string,
  answerer: Answerer,
  judge: Judge,
  repeats: number,
): Promise<{ baseline: ScoreSummary; pruned: ScoreSummary }> {
  const baseline = summarizeScores(await scoreContextRepeated(answerer, judge, query, fullContext, repeats));
  const pruned = summarizeScores(await scoreContextRepeated(answerer, judge, query, prunedContext, repeats));
  return { baseline, pruned };
}
