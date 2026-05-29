/**
 * CQ-Extended KadaneDial Algorithm (Phase 2 / v0.4.x).
 *
 * Extends base DyCP/KadaneDial (arXiv:2601.07994) with a temporal decay factor
 * λ. See docs/ALGORITHM.md for the formal spec. Pipeline:
 *   1. R_i = S_raw_i × λ^((now − t_i)/3600)        [temporal decay]
 *   2. S = z-score(R)  (σ=0 → use raw decayed R)    [normalize decayed scores]
 *   3. KadaneDial(S, g, θ)                           [multi-span selection]
 *
 * ──────────────────────────────────────────────────────────────────────────
 * STATUS: algorithm implemented + unit-tested on SYNTHETIC data with
 * hand-computed expectations. The accuracy EVAL (Faithfulness/Answer-Relevancy
 * vs full-context baseline — the project's definition of "correct" per
 * docs/EVAL_FRAMEWORK.md + stratum CLAUDE.md) is DEFERRED: it requires the §2b
 * capture corpus + the Tier-A datasets (LoCoMo/MT-Bench+/SCM4LLMs), which do
 * not exist yet. This code is NOT wired into the proxy and pruning is NOT
 * enabled anywhere — it is preparatory v0.4.x core, built ahead of the phase
 * gate at the user's explicit direction. Do NOT enable pruning in the request
 * path until the eval passes (<5% Faithfulness degradation).
 *
 * SPEC DEVIATIONS (documented): docs/ALGORITHM.md's KadaneDial pseudocode (a)
 * references `span_start` without ever assigning it, and (b) does not seed
 * `max_sum`/`span_end` when a span opens. Both are clear transcription bugs —
 * fixed here by setting span start + seeding max_sum/end with the opening
 * value. The single-turn edge case ("return that turn if its decayed
 * similarity exceeds the gain threshold") uses g (not θ) as the bar, so a
 * single turn is gated on adjusted>0, handled explicitly in selectRelevantTurns.
 *
 * KNOWN LIMITATION (found by the Tier-B eval, 2026-05-29): KadaneDial selects
 * CONTIGUOUS spans, so a low-relevance turn ADJACENT to a high-relevance peak is
 * retained inside the span (its negative gain doesn't pull the running sum below
 * the gate before the peak). On the Tier-B dev set this over-retains the turn
 * next to the answer (e.g. keeps a superseded "AWS Lambda" plan beside the
 * correct "Cloudflare Workers", and an off-topic turn beside the answer): 11/11
 * scenarios keep ANSWER FAITHFULNESS at 1.0, but 2/11 fail the strict "drop the
 * stale/noise turn" golden — a PRECISION cost, not a correctness one. The
 * eval:tierb gate is intentionally RED on this until calibrated. Candidate
 * refinements (defer to Tier-A calibration, do NOT over-fit synthetic): raise θ
 * so edge turns fall below the gate, or add a per-turn relevance floor that
 * trims low-gain turns at span edges. Tracked as a v0.4.x calibration item.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** A history turn's raw relevance to the current query + when it occurred. */
export interface HistoryTurn {
  /** Raw cosine similarity to the query (dot product of L2-normalized embeddings). */
  similarity: number;
  /** Unix timestamp (seconds) when the turn was recorded. */
  timestampSeconds: number;
}

export interface KadaneDialParams {
  /** Temporal decay per hour, (0,1]. */
  lambda: number;
  /** Gain shift g — a turn contributes positively when (score − g) > 0. */
  gainShift: number;
  /** Minimum cumulative gain θ (>0) for a span to be included. */
  theta: number;
  /** Current Unix timestamp (seconds). */
  nowSeconds: number;
}

export const DEFAULT_KADANEDIAL = { lambda: 0.97, gainShift: 0.0, theta: 1.0 } as const;

export interface PruneDecision {
  /** Selected contiguous spans as inclusive [start, end] index pairs. */
  spans: Array<[number, number]>;
  /** Selected turn indices (flattened, de-duplicated, ascending). */
  selectedIndices: number[];
  /** Pruned (not-selected) turn indices. */
  prunedIndices: number[];
  /** Decayed raw scores R_i (pre-normalization) — logged per spec. */
  decayedScores: number[];
  /** Normalized scores S (post-decay) — logged per spec. */
  normalizedScores: number[];
  /** Params used (incl. the gain threshold) — logged per spec. */
  params: KadaneDialParams;
  /** True when z-score normalization was skipped because σ = 0. */
  normalizationSkipped: boolean;
}

/** Apply temporal decay: R_i = S_raw_i × λ^((now − t_i)/3600). */
export function applyTemporalDecay(turns: HistoryTurn[], lambda: number, nowSeconds: number): number[] {
  return turns.map((t) => t.similarity * Math.pow(lambda, (nowSeconds - t.timestampSeconds) / 3600));
}

/** Population z-score. σ = 0 → returns the input unchanged (spec edge case). */
export function zScoreNormalize(values: number[]): { normalized: number[]; skipped: boolean } {
  const n = values.length;
  if (n === 0) return { normalized: [], skipped: false };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  // Near-zero σ, not exact: equal DECIMAL similarities (e.g. duplicate turns →
  // bit-identical cosines) sum with float drift to std≈5e-17, not 0. An exact
  // `=== 0` guard misses that case and z-normalizes [x,x,x] to [-1,-1,-1],
  // dropping ALL turns. Treat near-zero σ as the spec's σ=0 passthrough.
  if (std < 1e-9) return { normalized: [...values], skipped: true };
  return { normalized: values.map((v) => (v - mean) / std), skipped: false };
}

/**
 * KadaneDial multi-span selection: Kadane's max-subarray adapted to emit every
 * contiguous span whose peak cumulative gain (of score − g) reaches θ.
 *
 * @param scores - per-turn scores (normalized, or raw decayed when σ=0).
 * @param gainShift - g.
 * @param theta - θ (minimum cumulative gain for inclusion).
 * @returns inclusive [start, end] span pairs.
 */
export function kadaneDialSpans(scores: number[], gainShift: number, theta: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let currentStart: number | null = null;
  let currentSum = 0;
  let maxSum = 0;
  let spanEnd = 0;

  for (let i = 0; i < scores.length; i++) {
    const adjusted = (scores[i] ?? 0) - gainShift;
    if (currentStart === null) {
      if (adjusted > 0) {
        currentStart = i;
        currentSum = adjusted;
        maxSum = adjusted; // seed with the opening value (spec pseudocode omits this)
        spanEnd = i;
      }
    } else {
      currentSum += adjusted;
      if (currentSum > maxSum) {
        maxSum = currentSum;
        spanEnd = i;
      }
      if (currentSum <= 0) {
        if (maxSum >= theta - 1e-9) spans.push([currentStart, spanEnd]);
        currentStart = null;
        currentSum = 0;
        maxSum = 0;
      }
    }
  }
  // θ comparison with tolerance: a 2-element population z-score peaks at a
  // mathematical 1.0 that float arithmetic can render as 0.9999999999998 < θ,
  // which would wrongly discard the most-relevant turn of a 2-turn history.
  if (currentStart !== null && maxSum >= theta - 1e-9) spans.push([currentStart, spanEnd]);
  return spans;
}

/**
 * Full CQ-Extended pipeline → a logged pruning decision.
 *
 * @param turns - history turns (similarity + timestamp).
 * @param params - λ / g / θ / now.
 * @returns the {@link PruneDecision} (selected + pruned indices + scores + params).
 */
export function selectRelevantTurns(turns: HistoryTurn[], params: KadaneDialParams): PruneDecision {
  const decayedScores = applyTemporalDecay(turns, params.lambda, params.nowSeconds);

  // Edge cases (docs/ALGORITHM.md §Implementation Notes → Edge Cases):
  //  - empty history → no spans.
  //  - single turn → select iff its decayed similarity exceeds g (NOT θ).
  if (turns.length === 0) {
    return { spans: [], selectedIndices: [], prunedIndices: [], decayedScores, normalizedScores: [], params, normalizationSkipped: false };
  }
  if (turns.length === 1) {
    const selected = (decayedScores[0] ?? 0) - params.gainShift > 0;
    return {
      spans: selected ? [[0, 0]] : [],
      selectedIndices: selected ? [0] : [],
      prunedIndices: selected ? [] : [0],
      decayedScores,
      normalizedScores: [...decayedScores],
      params,
      normalizationSkipped: true,
    };
  }

  const { normalized, skipped } = zScoreNormalize(decayedScores);
  const spans = kadaneDialSpans(normalized, params.gainShift, params.theta);

  const selected = new Set<number>();
  for (const [s, e] of spans) for (let i = s; i <= e; i++) selected.add(i);
  const selectedIndices = [...selected].sort((a, b) => a - b);
  const prunedIndices = turns.map((_, i) => i).filter((i) => !selected.has(i));

  return { spans, selectedIndices, prunedIndices, decayedScores, normalizedScores: normalized, params, normalizationSkipped: skipped };
}

/** Half-life in hours for a given λ: −1 / log2(λ). */
export function halfLifeHours(lambda: number): number {
  return -1 / Math.log2(lambda);
}
