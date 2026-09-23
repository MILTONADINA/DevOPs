/**
 * Latency summary statistics (pure; used by scripts/bench-tiers.ts).
 *
 * Nearest-rank percentiles over a sample of millisecond timings — the form the
 * tier-latency gate compares against the documented targets (docs/MONITORING.md:
 * Tier-2 p95 < 80ms, Tier-3 vector p95 < 200ms; pruner p99 < 20ms; Tier-1 hot
 * sub-ms per docs/GLOSSARY.md). No I/O — unit-tested.
 */

export interface LatencySummary {
  /** Sample count. */
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * Nearest-rank percentile of an ASCENDING-sorted sample.
 *
 * @param sortedAsc - samples sorted ascending (non-empty).
 * @param p - percentile in [0, 100].
 * @returns the value at the nearest rank (index ceil(p/100·n)−1, clamped).
 * @throws {Error} if the sample is empty.
 */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new Error("percentile of an empty sample");
  const clampedP = Math.max(0, Math.min(100, p));
  const rank = Math.ceil((clampedP / 100) * n);
  const idx = Math.max(0, Math.min(n - 1, rank - 1));
  return sortedAsc[idx]!;
}

/**
 * Summarize a sample of millisecond timings.
 *
 * @param samplesMs - the timings (non-empty); not mutated (a copy is sorted).
 * @returns the {@link LatencySummary}.
 * @throws {Error} if the sample is empty.
 */
export function summarize(samplesMs: number[]): LatencySummary {
  if (samplesMs.length === 0) throw new Error("summarize of an empty sample");
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: sorted[0]!,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1]!,
    mean: sum / n,
  };
}
