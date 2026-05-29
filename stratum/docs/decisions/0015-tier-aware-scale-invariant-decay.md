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

## Validation (judged gate — 2026-05-29)

The calibrated config (`LOCOMO_DECAY_HORIZON_FRAC=1.0 LOCOMO_LAMBDAS=0.5`, scale-
invariant h=1.0·span) was run through the FULL judged `eval:locomo` (real ONNX +
Haiku, same 3 conv × 6 q as the ADR-0014 RED baseline) — the decisive test of
whether the retention fix also holds Faithfulness/Answer-Relevancy:

| config | evidence survival | ctx reduction | Faithfulness pruned/base (Δ) | Answer-Relevancy pruned/base (Δ) | scenarios pass |
|---|---|---|---|---|---|
| λ=0.97 per-hour (default) | 1.4% | 92% | 0.994 / 0.944 (−0.050) | 0.975 / 0.738 (−0.237) | 15/18 |
| **scale-invariant h=1.00·span** | **87.5%** | 38% | 0.914 / 0.942 (**+0.028**) | 0.841 / 0.749 (−0.091) | **10/18** |

Findings:
- **The calibration works for what matters: evidence retention 1.4%→87.5%**, while
  aggregate Faithfulness degradation is **+0.028 (within the <5% bar)** and
  Answer-Relevancy is *better* than baseline (less context dilution). By the
  constitution's actual criterion (<5% degradation), the AGGREGATE passes.
- **Yet it passes FEWER scenarios (10 vs 15)** — and that is mostly NOT pruning
  damage. The per-scenario gate also enforces ABSOLUTE floors (Faithfulness ≥0.90,
  Answer-Relevancy ≥0.88) on the PRUNED score regardless of the baseline. Several
  failures are floor trips where **baseline == pruned** (e.g. faith 0.85/0.85) or
  where the baseline ITSELF is below the floor (the "October 2023 setback" question:
  faith 0.50/0.70, relev 0.30/0.40 — the FULL-context answer is already poor). The
  gate is conflating "did pruning hurt?" (degradation) with "is the answer good in
  absolute terms?" (a question/answerer/judge-quality property the pruner doesn't
  control). A few are real (conv-41#12 faith 0.50/1.00).
- **Compounds ADR-0014 Finding 2 from the other side:** there, absolute floors let a
  1.4%-evidence pruner *pass* (it bluffed crisply); here, they make a 87.5%-evidence
  pruner *fail* on questions the baseline can't answer either. → the gate must be
  **degradation-DOMINANT** (the constitution's stated bar), with absolute floors only
  meaningful relative to the baseline, and run at a larger sample with repeat-and-
  average to damp judge noise (N=18 baseline relevancy swings 0.0–1.0). Tracked
  PB-39/PB-42/PB-43.

**Verdict: still RED — do NOT ship.** But the RED is no longer "the pruner destroys
the answer"; it is "the pruner retains the evidence and matches baseline within
tolerance, but the GATE is too strict/noisy to certify it." The remaining work is
gate refinement + a larger run + a second benchmark (PB-41 LongMemEval) before a
ship decision — NOT abandoning the calibration, which is validated as effective.

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
