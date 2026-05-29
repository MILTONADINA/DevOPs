# ADR-0015: Temporal Decay is Tier/Workload-Aware — Scale-Invariant Decay Option (default-OFF)

**Date:** 2026-05-29
**Status:** Accepted (mechanism built default-OFF; activation as a default is Tier-A-gated — see ADR-0014/0009)

## Context

ADR-0014's Tier-A LoCoMo gate was RED at the documented λ=0.97 (1.4% evidence
survival on the judged sample). To turn that into an actionable, non-over-fit
calibration finding, evidence survival — which is **deterministic** (gold
`evidence` turns ∩ the pruner's selection; no judge, no API) — was swept across
the WHOLE LoCoMo corpus for FREE (`npm run eval:locomo:survival`, local ONNX
only): 10 conversations, 120 timeline-spread questions, multiple decay models.

ADR-0002 fixed temporal decay as `λ^((now−t)/3600)` — a **per-hour** λ, hence a
**fixed half-life** (22.8h at λ=0.97). It was designed for intra-day coding
sessions. LoCoMo conversations span **166–293 days**.

### The free sweep (10 conv, 120 q, deterministic — no API)

| decay model | evidence survival | early-evidence | context reduction |
|---|---|---|---|
| abs λ=0.97 (DEFAULT, per-hour) | 3.8% | **2.0%** | 92.5% |
| abs λ=0.999 (per-hour) | 46.9% | 15.3% | 63.4% |
| abs λ=1.0 (no decay) | 84.5% | **89.3%** | 48.6% |
| scale-invariant h=1.00·span | **92.5%** | 87.3% | 39.1% |
| scale-invariant h=0.50·span | 82.7% | 63.5% | 45.2% |
| scale-invariant h=0.25·span | 62.7% | 26.8% | 55.1% |

("early-evidence" = questions whose earliest gold turn is in the first third of
the dialogue; "h=k·span" = `decayHorizonSeconds = k × the conversation's own
duration`, with λ=0.5, so the half-life is k× the whole span.)

## Findings

1. **Temporal decay is a RECENCY PRIOR; its value is workload-dependent.** LoCoMo
   needs UNIFORM recall (evidence is spread across the whole timeline), so *any*
   recency bias costs retrieval. At equal-ish reduction (~48%), pure relevance
   (λ=1.0, no decay) gives the best early-evidence survival (89.3%). The fixed
   per-hour λ=0.97 retains **2.0%** of early evidence corpus-wide — it isn't a
   tuning miss, it's the wrong *prior* for long-horizon recall.

2. **A fixed per-hour half-life does not generalize across horizons.** 22.8h is
   reasonable for an hours-long coding session and catastrophic for a months-long
   conversation. **Scale-invariant decay** — half-life as a fraction of the
   conversation's OWN span — restores survival (3.8%→92.5%) because a turn from
   "the previous session" decays the same whether the dialogue is hours or weeks.
   At h=1.00·span it nearly matches no-decay on early evidence (87.3% vs 89.3%)
   while keeping a principled recency prior AND still pruning 39%.

3. **This argues for TIER-AWARE decay — which the three-tier architecture already
   implies.** The HOT-tier pruner (intra-day request context) is where a strong
   recency prior (λ=0.97) is correct. Long-term MEMORY RECALL (warm/cold-tier
   retrieval) should be relevance-dominant: λ→1 or scale-invariant decay with a
   generous horizon. The two are different jobs; one global λ cannot serve both.

## Decision

1. **Add `decayHorizonSeconds` to `KadaneDialParams` (DEFAULT-OFF).** When unset,
   decay is the documented per-hour λ (behaviour byte-for-byte unchanged). When
   set, decay is `λ^((now−t)/decayHorizonSeconds)`; callers set it to a fraction
   of the live conversation span for scale-invariance. Implemented + unit-tested
   in `kadanedial.ts` / `applyTemporalDecay`.
2. **Do NOT change the documented default λ=0.97 or enable the new mode yet.**
   Same discipline as ADR-0011 / `trimCarriedTurns` / `suppressSuperseded`: build
   the mechanism, keep it off, gate activation on the FULL Tier-A suite passing
   (evidence survival + Faithfulness/Answer-Relevancy via the API'd `eval:locomo`,
   re-run on the chosen config) AND validation on MT-Bench+/SCM4LLMs (PB-41) so
   the choice is not over-fit to one benchmark. Evidence survival is ground truth,
   not a judge score, so this measurement is not "teaching to the test" — but the
   activation bar is still the full judged gate.
3. **When activation is taken up (PB-38):** wire `decayHorizonSeconds` from the
   memory-recall path (warm/cold retrieval) using the live conversation span,
   leaving the hot-tier request pruner on the per-hour λ. Re-run `eval:locomo`
   (judged) + the survival sweep to confirm the Faithfulness/Relevancy gate AND
   evidence survival both clear before any request-path wiring.

## Consequences

- Pruning stays out of the request path (ADR-0014 unchanged); this adds a
  measured, principled OPTION and the data to choose it, not a shipped change.
- `eval:locomo:survival` is a permanent FREE regression tool — any future decay
  change can be checked corpus-wide at zero API cost before spending on the
  judged gate.
- The three-tier memory design gains an explicit decay-policy boundary: recency-
  prior in hot, relevance-dominant in warm/cold. Recorded for the v0.5.x recall
  path + the v0.4.x ship decision.

## Alternatives Considered

- **Just set the global λ=1.0 (no decay).** Rejected: best for LoCoMo but discards
  the recency prior that benefits the intra-day hot tier the pruner was built for
  — and it's a global-default change on one benchmark (over-fitting). Scale-
  invariant decay keeps a tier-appropriate prior at every timescale.
- **Retune the per-hour λ upward (e.g. 0.999).** Rejected: 0.999 still only
  recovers 15.3% early-evidence (its 693h half-life is still < a months-long
  span), and it's a fixed half-life that breaks again at a different horizon.
- **Leave decay fixed; rely solely on supersession (ADR-0011).** Rejected as
  insufficient: supersession drops *invalidated* turns; it does not restore
  *valid* old evidence that fixed decay crushed. The two are complementary.
