// Unit tests for the encoder math (l2Normalize, cosineSimilarity), the gated
// ONNX factory, and the pruner orchestrator (with injected synthetic
// embeddings — no model needed). The accuracy eval is separate + deferred.

import { describe, test, expect } from "vitest";
import {
  l2Normalize,
  cosineSimilarity,
  createOnnxEncoder,
  EMBEDDING_DIM,
} from "../../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams } from "../../src/pruner/kadanedial";

const NOW = 1_000_000;
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe("encoder math", () => {
  test("l2Normalize makes a unit vector", () => {
    const out = l2Normalize(v(3, 4)); // ‖(3,4)‖=5 → (0.6,0.8)
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
    expect(Math.hypot(out[0]!, out[1]!)).toBeCloseTo(1, 6);
  });
  test("l2Normalize leaves the zero vector unchanged (no NaN)", () => {
    expect([...l2Normalize(v(0, 0, 0))]).toEqual([0, 0, 0]);
  });
  test("cosineSimilarity: identical unit → 1, orthogonal → 0, opposite → -1", () => {
    expect(cosineSimilarity(v(1, 0), v(1, 0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(v(1, 0), v(-1, 0))).toBeCloseTo(-1, 6);
  });
  test("cosineSimilarity throws on dimension mismatch", () => {
    expect(() => cosineSimilarity(v(1, 0), v(1, 0, 0))).toThrow(/dimension mismatch/);
  });
  test("EMBEDDING_DIM is 384 (all-MiniLM-L6-v2)", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});

describe("createOnnxEncoder — gated on the model artifact", () => {
  test("throws a clear, actionable error until the model is provided", async () => {
    await expect(createOnnxEncoder({ modelPath: "/models/all-MiniLM-L6-v2-int8.onnx" })).rejects.toThrow(
      /model artifact required|ONNX encoder unavailable/,
    );
  });
});

describe("prune — orchestrator over injected embeddings", () => {
  const params = (over: Partial<KadaneDialParams> = {}): KadaneDialParams => ({
    lambda: DEFAULT_KADANEDIAL.lambda,
    gainShift: DEFAULT_KADANEDIAL.gainShift,
    theta: DEFAULT_KADANEDIAL.theta,
    nowSeconds: NOW,
    ...over,
  });

  test("selects history turns whose embedding aligns with the query", () => {
    const query = v(1, 0); // L2-normalized
    const history: HistoryEmbedding[] = [
      { embedding: v(1, 0), timestampSeconds: NOW }, // sim 1  (aligned)
      { embedding: v(0, 1), timestampSeconds: NOW }, // sim 0
      { embedding: v(0, 1), timestampSeconds: NOW }, // sim 0
      { embedding: v(1, 0), timestampSeconds: NOW }, // sim 1  (aligned)
    ];
    // sims [1,0,0,1] → z-score [1,-1,-1,1] → KadaneDial(θ=1) → turns 0 & 3 kept
    const d = prune(query, history, params({ lambda: 1 }));
    expect(d.selectedIndices).toEqual([0, 3]);
    expect(d.prunedIndices).toEqual([1, 2]);
  });

  test("temporal decay prunes a stale-but-aligned turn", () => {
    const query = v(1, 0);
    const history: HistoryEmbedding[] = [
      { embedding: v(1, 0), timestampSeconds: NOW }, // recent, sim 1
      { embedding: v(1, 0), timestampSeconds: NOW - 100 * 3600 }, // 100h old, sim 1 but decays
    ];
    const d = prune(query, history, params({ lambda: 0.97 }));
    expect(d.selectedIndices).toEqual([0]);
    expect(d.prunedIndices).toEqual([1]);
  });

  test("empty history → empty decision", () => {
    const d = prune(v(1, 0), [], params());
    expect(d.selectedIndices).toEqual([]);
    expect(d.spans).toEqual([]);
  });
});
