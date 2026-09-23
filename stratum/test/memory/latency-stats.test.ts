// Unit tests for the pure latency-summary stats (no I/O).

import { describe, test, expect } from "vitest";
import { percentile, summarize } from "../../src/lib/latency-stats";

describe("percentile (nearest-rank, ascending sample)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
  test("standard percentiles over 1..100", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
    expect(percentile(oneToHundred, 0)).toBe(1);
  });
  test("single-element sample returns that element for any p", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
  test("p is clamped to [0,100]", () => {
    expect(percentile(oneToHundred, 150)).toBe(100);
    expect(percentile(oneToHundred, -10)).toBe(1);
  });
  test("throws on an empty sample (never invents a number)", () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
  });
});

describe("summarize", () => {
  test("computes n/min/max/mean/percentiles", () => {
    const s = summarize([40, 10, 30, 20]);
    expect(s).toMatchObject({ n: 4, min: 10, max: 40, mean: 25 });
    expect(s.p50).toBe(20); // rank ceil(0.5*4)=2 → idx 1 → 20
    expect(s.p95).toBe(40);
    expect(s.p99).toBe(40);
  });
  test("does not mutate the input", () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
  test("throws on an empty sample", () => {
    expect(() => summarize([])).toThrow(/empty/);
  });
});
