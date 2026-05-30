// Integration test for runQuestion's repeat-and-average wiring (PB-42), offline.
//
// runQuestion takes turn/query VECTORS (no encoder) and the answerer/judge by injection,
// so the whole flow — baseline R-sampling, per-λ R-sampling, the dedup CACHE keyed by
// selection signature, and std propagation — runs with NO model and NO API. The load-bearing
// property: at R>1, two λ with the SAME selection must reuse the cached R samples (no extra
// judge calls) — a real credit-cost invariant a threading bug could silently break.

import { describe, test, expect } from "vitest";
import { runQuestion } from "../../scripts/eval-locomo";
import type { Answerer, Judge } from "../../evals/harness/metrics";
import type { MetricScores } from "../../evals/harness/types";
import type { LocomoConversation, LocomoQuestion, LocomoTurn } from "../../evals/harness/locomo";

function f32(xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

function countingAnswerer(): { answerer: Answerer; calls: () => number } {
  let n = 0;
  return { answerer: { generate: async () => { n++; return `answer-${n}`; } }, calls: () => n };
}

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

function fixture(): { conv: LocomoConversation; q: LocomoQuestion; turnVecs: Float32Array[]; queryVec: Float32Array } {
  const turns: LocomoTurn[] = [
    { diaId: "D1:1", speaker: "A", text: "hello", timestampSeconds: 1000, sessionIndex: 1 },
    { diaId: "D1:2", speaker: "B", text: "world", timestampSeconds: 1001, sessionIndex: 1 },
    { diaId: "D2:1", speaker: "A", text: "again", timestampSeconds: 2000, sessionIndex: 2 },
  ];
  const conv: LocomoConversation = {
    sampleId: "conv-x",
    speakerA: "A",
    speakerB: "B",
    turns,
    diaIndex: new Map(turns.map((t, i) => [t.diaId, i])),
    questions: [],
  };
  const q: LocomoQuestion = { query: "what?", goldenAnswer: "x", evidence: ["D1:1"], category: 1 };
  // 4-d toy embeddings; selection is deterministic for fixed inputs (all we need — the dedup test
  // uses a DUPLICATE λ so the signature is identical regardless of WHAT gets selected).
  const turnVecs = [f32([1, 0, 0, 0]), f32([0, 1, 0, 0]), f32([0, 0, 1, 0])];
  const queryVec = f32([1, 0, 0, 0]);
  return { conv, q, turnVecs, queryVec };
}

describe("runQuestion repeat-and-average (PB-42)", () => {
  test("averages baseline + pruned over R samples; duplicate λ hits the cache (no extra cost)", async () => {
    const { conv, q, turnVecs, queryVec } = fixture();
    const a = countingAnswerer();
    // 4 distinct judge scores are enough: 2 baseline + 2 pruned; the SECOND λ=0.97 is a cache hit.
    const j = queueJudge([
      { faithfulness: 0.8, answerRelevancy: 0.2 },
      { faithfulness: 1.0, answerRelevancy: 0.4 },
      { faithfulness: 0.9, answerRelevancy: 0.5 },
      { faithfulness: 0.7, answerRelevancy: 0.9 },
    ]);
    const o = await runQuestion(conv, q, queryVec, turnVecs, 3600, [0.97, 0.97], a.answerer, j.judge, undefined, 2);

    // Credit-cost invariant: 2 baseline + 2 pruned = 4 (the duplicate λ reuses the cached samples).
    expect(j.calls()).toBe(4);
    expect(a.calls()).toBe(4);

    // Baseline = mean of samples 1,2.
    expect(o.baseline.faithfulness).toBeCloseTo(0.9, 6);
    expect(o.baseline.answerRelevancy).toBeCloseTo(0.3, 6);
    expect(o.baselineStd.faithfulness).toBeCloseTo(Math.sqrt(0.02), 6);

    // Both λ entries present; both carry the SAME cached pruned summary (mean of samples 3,4).
    expect(o.byLambda).toHaveLength(2);
    expect(o.byLambda[0]!.pruned.faithfulness).toBeCloseTo(0.8, 6);
    expect(o.byLambda[0]!.pruned.answerRelevancy).toBeCloseTo(0.7, 6);
    expect(o.byLambda[0]!.prunedStd.answerRelevancy).toBeCloseTo(Math.sqrt(0.08), 6); // (±0.2)²·2 / 1
    expect(o.byLambda[1]!.pruned).toEqual(o.byLambda[0]!.pruned); // cache → byte-identical
  });

  test("R=1 is a single shot (one answer→judge per context)", async () => {
    const { conv, q, turnVecs, queryVec } = fixture();
    const a = countingAnswerer();
    const j = queueJudge([{ faithfulness: 1, answerRelevancy: 1 }]);
    const o = await runQuestion(conv, q, queryVec, turnVecs, 3600, [0.97], a.answerer, j.judge, undefined, 1);
    expect(j.calls()).toBe(2); // 1 baseline + 1 pruned
    expect(o.baselineStd).toEqual({ faithfulness: 0, answerRelevancy: 0 }); // no spread at R=1
  });
});
