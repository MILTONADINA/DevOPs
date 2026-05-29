// Unit tests for the CQ-Extended KadaneDial algorithm — hand-computed
// expectations on synthetic data. These verify the MATH is correct. They do
// NOT verify pruning preserves answer quality — that is the deferred accuracy
// eval (needs the §2b corpus + Tier-A datasets) per docs/EVAL_FRAMEWORK.md.

import { describe, test, expect } from "vitest";
import {
  applyTemporalDecay,
  zScoreNormalize,
  kadaneDialSpans,
  selectRelevantTurns,
  halfLifeHours,
  DEFAULT_KADANEDIAL,
  type HistoryTurn,
  type KadaneDialParams,
} from "../../src/pruner/kadanedial";

const NOW = 1_000_000; // arbitrary fixed "now" in seconds
const params = (over: Partial<KadaneDialParams> = {}): KadaneDialParams => ({
  lambda: DEFAULT_KADANEDIAL.lambda,
  gainShift: DEFAULT_KADANEDIAL.gainShift,
  theta: DEFAULT_KADANEDIAL.theta,
  nowSeconds: NOW,
  ...over,
});

describe("applyTemporalDecay — R_i = S_raw × λ^((now−t)/3600)", () => {
  test("no elapsed time → no decay", () => {
    expect(applyTemporalDecay([{ similarity: 0.8, timestampSeconds: NOW }], 0.97, NOW)).toEqual([0.8]);
  });
  test("one hour ago → ×λ", () => {
    const [r] = applyTemporalDecay([{ similarity: 1, timestampSeconds: NOW - 3600 }], 0.97, NOW);
    expect(r).toBeCloseTo(0.97, 10);
  });
  test("λ=1 → never decays", () => {
    const [r] = applyTemporalDecay([{ similarity: 0.5, timestampSeconds: NOW - 999 * 3600 }], 1, NOW);
    expect(r).toBe(0.5);
  });
});

describe("zScoreNormalize — population z-score, σ=0 passthrough", () => {
  test("[1,2,3] → [-1.2247, 0, 1.2247]", () => {
    const { normalized, skipped } = zScoreNormalize([1, 2, 3]);
    expect(skipped).toBe(false);
    expect(normalized[0]).toBeCloseTo(-1.224745, 5);
    expect(normalized[1]).toBeCloseTo(0, 5);
    expect(normalized[2]).toBeCloseTo(1.224745, 5);
  });
  test("σ=0 (identical) → skipped + raw passthrough", () => {
    const { normalized, skipped } = zScoreNormalize([5, 5, 5]);
    expect(skipped).toBe(true);
    expect(normalized).toEqual([5, 5, 5]);
  });
  test("empty → []", () => {
    expect(zScoreNormalize([])).toEqual({ normalized: [], skipped: false });
  });
});

describe("kadaneDialSpans — multi-span selection", () => {
  test("two relevant blocks separated by a negative dip", () => {
    // [2,-3,2,2]: span [0,0] (peak 2≥θ), dip resets, span [2,3] (peak 4≥θ)
    expect(kadaneDialSpans([2, -3, 2, 2], 0, 1)).toEqual([
      [0, 0],
      [2, 3],
    ]);
  });
  test("all-negative → no spans", () => {
    expect(kadaneDialSpans([-1, -2, -0.5], 0, 1)).toEqual([]);
  });
  test("single value below θ → excluded; at/above θ → included", () => {
    expect(kadaneDialSpans([0.5], 0, 1)).toEqual([]);
    expect(kadaneDialSpans([2], 0, 1)).toEqual([[0, 0]]);
  });
  test("gain shift g reduces every score; cumulative still reaches θ", () => {
    // [1,1,1], g=0.5 → adjusted 0.5 each; cumulative 0.5,1.0,1.5 → span [0,2]
    expect(kadaneDialSpans([1, 1, 1], 0.5, 1)).toEqual([[0, 2]]);
  });
});

describe("selectRelevantTurns — full pipeline + decision log", () => {
  test("empty history → empty decision (no crash)", () => {
    const d = selectRelevantTurns([], params());
    expect(d.spans).toEqual([]);
    expect(d.selectedIndices).toEqual([]);
    expect(d.prunedIndices).toEqual([]);
  });

  test("single turn: selected iff decayed similarity exceeds g", () => {
    const sel = selectRelevantTurns([{ similarity: 0.5, timestampSeconds: NOW }], params({ gainShift: 0 }));
    expect(sel.selectedIndices).toEqual([0]);
    expect(sel.spans).toEqual([[0, 0]]);

    const notSel = selectRelevantTurns([{ similarity: 0.5, timestampSeconds: NOW }], params({ gainShift: 0.6 }));
    expect(notSel.selectedIndices).toEqual([]);
    expect(notSel.prunedIndices).toEqual([0]);
  });

  test("relevant turns selected, irrelevant pruned (no decay, equal timestamps)", () => {
    const turns: HistoryTurn[] = [
      { similarity: 0.9, timestampSeconds: NOW },
      { similarity: 0.1, timestampSeconds: NOW },
      { similarity: 0.1, timestampSeconds: NOW },
      { similarity: 0.9, timestampSeconds: NOW },
    ];
    // decayed = sims; z-score → [1,-1,-1,1]; KadaneDial(θ=1) → [[0,0],[3,3]]
    const d = selectRelevantTurns(turns, params({ lambda: 1 }));
    expect(d.selectedIndices).toEqual([0, 3]);
    expect(d.prunedIndices).toEqual([1, 2]);
    expect(d.params.gainShift).toBe(0); // decision log carries the threshold
    expect(d.decayedScores).toHaveLength(4);
  });

  test("temporal decay prunes a stale-but-similar turn", () => {
    // Two equally-similar turns; one is 100h old → decays far below the recent one.
    const turns: HistoryTurn[] = [
      { similarity: 1, timestampSeconds: NOW },
      { similarity: 1, timestampSeconds: NOW - 100 * 3600 },
    ];
    const d = selectRelevantTurns(turns, params({ lambda: 0.97 }));
    expect(d.selectedIndices).toEqual([0]); // recent kept
    expect(d.prunedIndices).toEqual([1]); // stale pruned — the CQ extension's point
  });

  test("σ=0 across multiple identical turns → normalization skipped", () => {
    const turns: HistoryTurn[] = [
      { similarity: 1, timestampSeconds: NOW },
      { similarity: 1, timestampSeconds: NOW },
    ];
    const d = selectRelevantTurns(turns, params({ lambda: 1 }));
    expect(d.normalizationSkipped).toBe(true);
    expect(d.selectedIndices).toEqual([0, 1]); // both kept (cumulative 2 ≥ θ)
  });
});

// Regression tests for float-drift defects found by adversarial verification.
describe("float-drift edge cases (regression)", () => {
  test("σ=0 with equal DECIMAL similarities → skipped (was z-normalized to [-1,-1,-1], dropping all)", () => {
    const z = zScoreNormalize([0.4, 0.4, 0.4]); // 0.4+0.4+0.4 = 1.2000000000000002 → std≈5e-17, not 0
    expect(z.skipped).toBe(true);
    expect(z.normalized).toEqual([0.4, 0.4, 0.4]);
  });

  test("equal-decimal-similarity turns are KEPT, not all pruned", () => {
    const turns: HistoryTurn[] = [
      { similarity: 0.4, timestampSeconds: NOW },
      { similarity: 0.4, timestampSeconds: NOW },
      { similarity: 0.4, timestampSeconds: NOW },
    ];
    const d = selectRelevantTurns(turns, params({ lambda: 1 }));
    expect(d.normalizationSkipped).toBe(true);
    expect(d.selectedIndices).toEqual([0, 1, 2]); // before fix: [] (all dropped)
  });

  test("2-turn θ=1 boundary: the most-relevant turn survives float drift (was dropped)", () => {
    // population z of 2 distinct values is mathematically [+1,-1]; float yields
    // [0.9999999999999998, -1.0000000000000002], which < θ=1 dropped both pre-fix.
    const turns: HistoryTurn[] = [
      { similarity: -0.2, timestampSeconds: NOW },
      { similarity: -0.5, timestampSeconds: NOW },
    ];
    const d = selectRelevantTurns(turns, params()); // DEFAULT θ=1
    expect(d.selectedIndices).toEqual([0]); // before fix: []
  });
});

// Opt-in over-retention refinement (default off; Tier-A-validation-pending).
describe("trimCarriedTurns (opt-in span-edge refinement)", () => {
  const mk = (sims: number[]): HistoryTurn[] => sims.map((s, i) => ({ similarity: s, timestampSeconds: NOW - i * 3600 }));

  test("trimmed selection is a SUBSET of untrimmed (only removes, never adds)", () => {
    const turns = mk([0.9, 0.2, 0.85, 0.15, 0.8]);
    const base = selectRelevantTurns(turns, params({ theta: 0.5 }));
    const trimmed = selectRelevantTurns(turns, params({ theta: 0.5, trimCarriedTurns: true }));
    for (const i of trimmed.selectedIndices) expect(base.selectedIndices).toContain(i);
  });

  test("every kept turn individually clears the gain bar when trimming", () => {
    const turns = mk([0.95, 0.3, 0.9, 0.25, 0.88, 0.2]);
    const d = selectRelevantTurns(turns, params({ theta: 0.5, trimCarriedTurns: true }));
    for (const i of d.selectedIndices) {
      expect((d.normalizedScores[i] ?? 0) - DEFAULT_KADANEDIAL.gainShift).toBeGreaterThan(0);
    }
  });

  test("default (trim off) leaves selection unchanged", () => {
    const turns = mk([0.9, 0.2, 0.85]);
    const off = selectRelevantTurns(turns, params({ theta: 0.5 }));
    const explicitOff = selectRelevantTurns(turns, params({ theta: 0.5, trimCarriedTurns: false }));
    expect(off.selectedIndices).toEqual(explicitOff.selectedIndices);
  });
});

describe("halfLifeHours", () => {
  test("λ=0.5 → 1 hour; λ=0.97 → ~23h", () => {
    expect(halfLifeHours(0.5)).toBeCloseTo(1, 10);
    expect(halfLifeHours(0.97)).toBeCloseTo(22.757, 2);
  });
});
