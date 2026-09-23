// Tests for the PB-42 repeat-and-average noise damping: summarizeScores (pure) +
// scoreContextRepeated (the R-sample driver, with fake answerer/judge). The mechanism
// is fully exercised with NO API — only a REAL R× run costs R× credits.

import { describe, test, expect } from "vitest";
import { summarizeScores } from "../../evals/harness/aggregate";
import { scoreContextRepeated, type Answerer, type Judge } from "../../evals/harness/metrics";
import type { MetricScores } from "../../evals/harness/types";

function countingAnswerer(): { answerer: Answerer; calls: () => number } {
  let n = 0;
  return { answerer: { generate: async () => { n++; return "answer"; } }, calls: () => n };
}

/** A judge that returns successive scores from a queue (last value repeats if drained). */
function queueJudge(scores: MetricScores[]): { judge: Judge; calls: () => number } {
  let i = 0;
  return {
    judge: {
      score: async () => {
        const s = scores[Math.min(i, scores.length - 1)]!;
        i++;
        return s;
      },
    },
    calls: () => i,
  };
}

describe("summarizeScores", () => {
  test("single sample → mean = the sample, std = 0", () => {
    const s = summarizeScores([{ faithfulness: 0.7, answerRelevancy: 0.4 }]);
    expect(s.mean).toEqual({ faithfulness: 0.7, answerRelevancy: 0.4 });
    expect(s.std).toEqual({ faithfulness: 0, answerRelevancy: 0 });
    expect(s.samples).toBe(1);
  });

  test("mean + Bessel-corrected sample std (÷ n−1)", () => {
    const s = summarizeScores([
      { faithfulness: 0.8, answerRelevancy: 0.0 },
      { faithfulness: 1.0, answerRelevancy: 1.0 },
    ]);
    expect(s.mean.faithfulness).toBeCloseTo(0.9, 6);
    expect(s.mean.answerRelevancy).toBeCloseTo(0.5, 6);
    expect(s.std.faithfulness).toBeCloseTo(Math.sqrt(0.02), 6); // ((±0.1)²·2)/(2−1)
    expect(s.std.answerRelevancy).toBeCloseTo(Math.SQRT1_2, 6); // sqrt(0.5): the 0–1 swing ADR-0015 saw
    expect(s.samples).toBe(2);
  });

  test("empty samples throws — never averages nothing into a silent 0", () => {
    expect(() => summarizeScores([])).toThrow(/at least one/);
  });
});

describe("scoreContextRepeated", () => {
  test("draws R samples, one answer→judge cycle each", async () => {
    const a = countingAnswerer();
    const j = queueJudge([
      { faithfulness: 0.8, answerRelevancy: 0.2 },
      { faithfulness: 0.9, answerRelevancy: 1.0 },
      { faithfulness: 1.0, answerRelevancy: 0.6 },
    ]);
    const samples = await scoreContextRepeated(a.answerer, j.judge, "q", "ctx", 3);
    expect(samples).toHaveLength(3);
    expect(a.calls()).toBe(3); // answerer re-run each repeat (answer variance is the dominant noise)
    expect(j.calls()).toBe(3);
    const sum = summarizeScores(samples);
    expect(sum.mean.faithfulness).toBeCloseTo(0.9, 6);
    expect(sum.mean.answerRelevancy).toBeCloseTo(0.6, 6);
    expect(sum.std.answerRelevancy).toBeGreaterThan(0.3); // the wide judge noise is surfaced, not hidden
  });

  test("repeats clamps to an integer ≥ 1", async () => {
    const a = countingAnswerer();
    const j = queueJudge([{ faithfulness: 1, answerRelevancy: 1 }]);
    expect(await scoreContextRepeated(a.answerer, j.judge, "q", "c", 0)).toHaveLength(1);
    expect(await scoreContextRepeated(a.answerer, j.judge, "q", "c", -5)).toHaveLength(1);
    expect(await scoreContextRepeated(a.answerer, j.judge, "q", "c", 2.9)).toHaveLength(2);
    expect(await scoreContextRepeated(a.answerer, j.judge, "q", "c")).toHaveLength(1); // default
  });
});
