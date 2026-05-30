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
 * docs/EVAL_FRAMEWORK.md + stratum CLAUDE.md) has now RUN against a published
 * Tier-A benchmark (LoCoMo, `npm run eval:locomo`, ADR-0014) and is **RED** at
 * the documented λ=0.97: only **1.4% of gold evidence survives** (22.8h
 * half-life crushes LoCoMo's weeks-old evidence), and the λ sweep shows λ=1.0
 * (no decay) recovers 84% evidence at 47% reduction. λ is NOT retuned from this
 * sample (ADR-0011 discipline / forbidden over-fitting). This code is NOT wired
 * into the proxy and pruning is NOT enabled anywhere — it is preparatory v0.4.x
 * core. Do NOT enable pruning in the request path until the gate passes
 * (<5% Faithfulness degradation AND evidence survival holds). MT-Bench+/SCM4LLMs
 * Tier-A loaders are still pending.
 *   CALIBRATION (ADR-0015, free corpus-wide survival sweep `eval:locomo:survival`,
 *   10 conv / 120 q, deterministic — no API): the fixed per-HOUR λ is the wrong
 *   PRIOR for long-horizon recall — λ=0.97 retains 2% of EARLY gold evidence,
 *   λ=1.0 (no decay) 89%. Temporal decay is a recency prior whose value is
 *   TIER-dependent (hot/intra-day = strong, warm/cold recall = relevance-dominant).
 *   New DEFAULT-OFF `decayHorizonSeconds` makes decay scale-invariant (half-life
 *   relative to the conversation's own span): h=1.00·span recovers evidence
 *   survival 3.8%→92.5% at 39% reduction. Default per-hour λ=0.97 UNCHANGED;
 *   activation of the new mode is Tier-A-gated (judged eval:locomo + PB-41).
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
 * eval:tierb gate is intentionally RED on this until addressed.
 *   PARAMETER SWEEP RESULT (npm run sweep-params; this conclusion was itself
 *   overstated TWICE before being verified against the matrix — first "not
 *   tunable / structural", then "tb-negation fails at every cell"; BOTH false):
 *   the two hard scenarios have OPPOSING λ requirements, so no single (θ,λ)
 *   reaches 11/11 — the max anywhere is 10/11.
 *     • tb-dormant passes ONLY at λ≥0.99 (gentle decay: the 80h-old answer must
 *       not decay below a 10h noise turn). It FAILS at λ≤0.98.
 *     • tb-negation passes ONLY at λ≤0.95 (heavy decay drops the stale 30h "AWS
 *       Lambda" turn so the contiguous span no longer reaches it). It FAILS at
 *       λ≥0.97 (where the stale turn stays positive-gain + on-topic + adjacent).
 *     So NEITHER is structurally-unrecoverable — each is individually
 *     λ-recoverable — but they pull λ in OPPOSITE directions; satisfying one
 *     fails the other (and low-λ recovery of tb-negation newly fails tb-migration).
 *     No scenario fails at every cell. Raising θ instead drops needed facts.
 *   CANDIDATE-FIX RESULT (trimCarriedTurns, opt-in default-OFF): measured — does
 *   NOT help at the default λ (the kept turns are positive-gain on-topic, not
 *   negative-gain "carried"). The right fix is a mechanism ORTHOGONAL to decay —
 *   supersession (drop a turn a newer one invalidates, regardless of λ) — which
 *   could reach 11/11 WITHOUT the λ tension; designed in ADR-0011, to be validated
 *   against Tier-A (an 11-scenario dev set cannot justify retuning the documented
 *   λ=0.97, which is therefore unchanged). The trim stays a sound default-OFF
 *   refinement for the negative-gain case it DOES address. v0.4.x calibration item.
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
  /**
   * OPT-IN refinement (default off): after span selection, drop selected turns
   * whose own normalized gain is ≤ g — i.e. low-relevance turns "carried" inside
   * a span by a high-relevance neighbor (the contiguous-span over-retention found
   * by the Tier-B eval; see header). Off by default so behavior is unchanged;
   * activation as a default awaits Tier-A faithfulness validation (constitution).
   */
  trimCarriedTurns?: boolean;
  /**
   * OPT-IN (default off → fixed per-HOUR decay): the time unit (seconds) the
   * decay exponent is measured in. Decay becomes λ^((now − t_i)/decayHorizonSeconds);
   * unset ⇒ 3600 (the documented per-hour λ, behaviour unchanged). Setting it to a
   * fraction of the CONVERSATION'S OWN span makes decay SCALE-INVARIANT — a turn
   * from "the previous session" decays the same whether the dialogue spans hours
   * or weeks. Motivated by the Tier-A LoCoMo finding (ADR-0014): the fixed 22.8h
   * half-life retained only 1.4% of weeks-old gold evidence. Off by default;
   * activation as a default is Tier-A-gated (evidence-survival + Faithfulness),
   * same discipline as {@link trimCarriedTurns} (constitution / ADR-0011).
   */
  decayHorizonSeconds?: number;
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

/**
 * Apply temporal decay: R_i = S_raw_i × λ^((now − t_i)/horizonSeconds).
 *
 * @param turns - history turns (similarity + timestamp).
 * @param lambda - decay factor per horizon-unit, (0,1].
 * @param nowSeconds - current Unix timestamp.
 * @param horizonSeconds - the time unit the exponent is measured in (default 3600
 *   = per hour, the documented behaviour). A span-relative value makes decay
 *   scale-invariant (see {@link KadaneDialParams.decayHorizonSeconds}).
 * @returns the decayed scores R_i.
 */
export function applyTemporalDecay(turns: HistoryTurn[], lambda: number, nowSeconds: number, horizonSeconds = 3600): number[] {
  // Enforce the documented (0,1] contract loudly: lambda ≤ 0 / NaN would make pow() return NaN, which
  // bypasses the σ=0 guard (NaN < 1e-9 is false) and silently fail-OPEN to an empty selection. Boundary
  // validation (config CHECK + validateConfigPatch + OpenAPI) already rejects bad lambda; this is the
  // algorithm core asserting its own contract so an internal misuse fails loud, not silent.
  if (!(lambda > 0 && lambda <= 1)) throw new RangeError(`lambda must be in (0,1], got ${lambda}`);
  const unit = horizonSeconds > 0 ? horizonSeconds : 3600; // guard: non-positive ⇒ per-hour
  return turns.map((t) => {
    // Clamp elapsed to ≥ 0: a future/clock-skewed timestamp (now < t) makes the exponent negative and
    // pow(lambda<1, neg) > 1 — AMPLIFYING the turn instead of decaying it. The spec domain is
    // (now − t) ≥ 0, so a future turn decays by factor 1.0 (treated as present), never boosted.
    const elapsed = Math.max(0, nowSeconds - t.timestampSeconds);
    return t.similarity * Math.pow(lambda, elapsed / unit);
  });
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
  // `!(std >= 1e-9)` (not `std < 1e-9`) so a NON-FINITE std (NaN/Infinity from upstream bad data) ALSO
  // takes the passthrough — `NaN < 1e-9` is false and would divide by NaN, fail-OPEN to all-NaN scores.
  if (!(std >= 1e-9)) return { normalized: [...values], skipped: true };
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
  const decayedScores = applyTemporalDecay(turns, params.lambda, params.nowSeconds, params.decayHorizonSeconds ?? 3600);

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
  // OPT-IN trim (default off): drop selected turns whose own normalized gain is
  // ≤ g — low-relevance turns carried inside a span by a neighbor. Addresses the
  // contiguous-span over-retention (see header); off by default → behavior
  // unchanged + Tier-A-validation-pending before it can become the default.
  if (params.trimCarriedTurns) {
    for (const i of [...selected]) {
      if ((normalized[i] ?? 0) - params.gainShift <= 0) selected.delete(i);
    }
  }
  const selectedIndices = [...selected].sort((a, b) => a - b);
  const prunedIndices = turns.map((_, i) => i).filter((i) => !selected.has(i));

  return { spans, selectedIndices, prunedIndices, decayedScores, normalizedScores: normalized, params, normalizationSkipped: skipped };
}

/** Half-life in hours for a given λ: −1 / log2(λ). λ≥1 = no decay → Infinity. */
export function halfLifeHours(lambda: number): number {
  if (lambda >= 1) return Infinity; // no decay (log2(1)=0 would yield −Infinity)
  return -1 / Math.log2(lambda);
}
