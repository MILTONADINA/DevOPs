import { describe, expect, test } from "vitest";
import { scoreLongMemContexts } from "../../evals/harness/longmemeval-scoring";
import type { Answerer, Judge } from "../../evals/harness/metrics";
import type { MetricScores } from "../../evals/harness/types";

function fakes(scores: MetricScores[]): { answerer: Answerer; judge: Judge; calls: () => { answerer: number; judge: number } } {
  let answerCalls = 0;
  let judgeCalls = 0;
  const answerer: Answerer = { generate: async (_query, context) => `${context}-${++answerCalls}` };
  const judge: Judge = { score: async () => scores[judgeCalls++]! };
  return { answerer, judge, calls: () => ({ answerer: answerCalls, judge: judgeCalls }) };
}

describe("LongMemEval repeat-and-average scoring", () => {
  test("R=2 averages both contexts and exposes their sample spread", async () => {
    const fake = fakes([
      { faithfulness: 0.8, answerRelevancy: 0.3 },
      { faithfulness: 1.0, answerRelevancy: 0.5 },
      { faithfulness: 0.6, answerRelevancy: 0.7 },
      { faithfulness: 1.0, answerRelevancy: 0.9 },
    ]);
    const scores = await scoreLongMemContexts("question", "full", "pruned", fake.answerer, fake.judge, 2);
    expect(fake.calls()).toEqual({ answerer: 4, judge: 4 });
    expect(scores.baseline.mean.faithfulness).toBeCloseTo(0.9);
    expect(scores.baseline.mean.answerRelevancy).toBeCloseTo(0.4);
    expect(scores.pruned.mean.faithfulness).toBeCloseTo(0.8);
    expect(scores.pruned.mean.answerRelevancy).toBeCloseTo(0.8);
    expect(scores.pruned.std.faithfulness).toBeCloseTo(Math.sqrt(0.08));
    expect(scores.baseline.samples).toBe(2);
    expect(scores.pruned.samples).toBe(2);
  });

  test("R=1 keeps one score per context", async () => {
    const fake = fakes([
      { faithfulness: 0.9, answerRelevancy: 0.8 },
      { faithfulness: 0.7, answerRelevancy: 0.6 },
    ]);
    const scores = await scoreLongMemContexts("question", "full", "pruned", fake.answerer, fake.judge, 1);
    expect(fake.calls()).toEqual({ answerer: 2, judge: 2 });
    expect(scores.baseline.mean.faithfulness).toBe(0.9);
    expect(scores.pruned.mean.faithfulness).toBe(0.7);
    expect(scores.baseline.std).toEqual({ faithfulness: 0, answerRelevancy: 0 });
  });
});
