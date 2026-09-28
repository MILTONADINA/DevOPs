# ADR-0014: Tier-A LoCoMo Integration, the λ-Horizon Finding, and Evidence-Survival Co-Gating

**Date:** 2026-05-29
**Status:** Accepted (the gate is wired + run; pruning stays OUT of the request path — RED, correctly)

## Context

The constitution (stratum `.claude/CLAUDE.md` "Eval Before Ship" + `docs/EVAL_FRAMEWORK.md`
+ ADR-0009) blocks enabling pruning until a **published Tier-A benchmark** shows
<5% Faithfulness AND <5% Answer-Relevancy degradation vs the full-context
baseline. Until now that gate was deferred ("datasets do not exist yet"). They
do: **LoCoMo** (snap-research/locomo, arXiv:2402.17753, *Evaluating Very
Long-Term Conversational Memory of LLM Agents*) is free and self-serviceable.

LoCoMo is the hardest possible test for a temporal-decay pruner: 10 multi-session
dialogues (19–32 sessions, 369–689 turns) spanning **weeks**, each with a QA
battery whose answers are buried somewhere in that long history, with `evidence`
dialogue-ids pinning the exact turns that contain each answer.

### What was built

- **Loader** `evals/harness/locomo.ts` — PURE (no model/API/network), 13/13 unit
  tests (`test/evals/locomo.test.ts`) against an inline synthetic sample so CI
  never depends on the corpus. Parses session `date_time` → real Unix timestamps
  (so decay runs on the true multi-week axis), builds a `dia_id → turn-index` map
  (so `evidence` resolves to turns), and deterministically samples timeline-spread
  questions (cats 1–4; cat-5 adversarial/refusal excluded — it tests refusal, not
  retention).
- **Gated runner** `scripts/eval-locomo.ts` (`npm run eval:locomo`) — encode (real
  ONNX all-MiniLM-L6-v2) → KadaneDial `prune()` → answer pruned-vs-full → Claude-
  Haiku judge → gate (`gateScenario`/`evaluateSuite`). Sampled + cost-bounded; a
  λ sweep characterizes the decay/horizon tradeoff in one pass. Baseline computed
  once per question; pruned calls deduped by selection signature.
- **Data handling (licensing):** LoCoMo is **CC BY-NC 4.0** (NonCommercial +
  Attribution). Local eval is permitted NonCommercial use; the corpus is **NOT
  committed/redistributed** (gitignored — `evals/datasets/locomo/`), only the
  loader/runner code is. Attribution retained in the loader header.

## The run (2026-05-29)

`LOCOMO_CONVERSATIONS=3 LOCOMO_QUESTIONS=6 LOCOMO_LAMBDAS=0.97,0.999,1.0` →
3 conversations (conv-26/30/41), 18 answerable questions, real ONNX + real Haiku.
`now` = last turn + 1h (the query is asked just after the final session).

**Gate (λ = 0.97 — the documented shipping default, 22.8h half-life): FAIL.**

| signal | value |
|---|---|
| Scenarios within threshold | **15/18** (3 fail on Answer-Relevancy) |
| **Evidence survival** | **1.4%** |
| Mean context reduction | 92% |
| Faithfulness pruned / baseline (Δ) | 0.994 / 0.944 (**−0.050**, pruned *higher*) |
| Answer-Relevancy pruned / baseline (Δ) | 0.975 / 0.738 (**−0.237**, pruned *higher*) |

Failing scenarios: `conv-26#3` (relev deg 0.10), `conv-30#9` (relev 0.85 < 0.88
floor + deg 0.07), `conv-41#13` (relev deg 0.10).

**λ sweep (characterization — NOT auto-tuning):**

| λ | half-life | evidence survival | context reduction | ΔFaithfulness | ΔAnswerRelevancy |
|---|---|---|---|---|---|
| 0.97 | 23 h | **1%** | 92% | −0.050 | −0.237 |
| 0.999 | 693 h (≈29 d) | 41% | 65% | −0.019 | −0.070 |
| 1.0 | ∞ (no decay) | **84%** | 47% | −0.003 | −0.064 |

## Findings

1. **λ=0.97 is catastrophic for long-horizon memory.** A 22.8h half-life decays
   LoCoMo's weeks-old evidence to ~0, so the pruner keeps only the most recent
   ~35–40 turns and retains **1.4%** of answer evidence. This is calibration for
   intra-day coding sessions, not multi-week conversation — exactly the regime
   ADR-0002 (time-based decay) was designed for but never validated at this
   horizon. **Pruning must NOT be enabled in the request path.** (Constitution
   honored.)

2. **Faithfulness + Answer-Relevancy (pruned-vs-baseline) are INSUFFICIENT to
   gate long-horizon pruning — they can be gamed.** On the aggregate, pruned
   scored *better* than baseline on both metrics, because (a) handing Haiku all
   400–689 turns **dilutes** its answer (baseline relevancy 0.738, several 0.300,
   one 0.000), while (b) the recent-only pruned context yields a crisp, confident
   answer that is *faithful to the kept turns* (faithfulness 0.994) yet **not
   grounded in the actual evidence** (it bluffs plausibly from recency). The
   per-scenario gate only went RED because judge variance pushed 3 scenarios'
   pruned relevancy below floor/tolerance — i.e. **the constitution's headline
   gate very nearly PASSED a pruner that throws away 98.6% of evidence.** The
   deterministic, gold-anchored **evidence-survival** signal is what makes the
   verdict trustworthy.

3. **The calibration path is real and quantified.** λ=1.0 (pure relevance, no
   decay) recovers **84%** evidence survival at a still-useful 47% reduction;
   λ=0.999 (≈29-day half-life) gives 41% at 65%. The remaining 16% miss at λ=1.0
   is an encoder/relevance limit (multi-hop / lexically-distant evidence), not a
   decay artifact — a separate, smaller problem.

## Decision

1. **Keep pruning out of the request path.** The Tier-A gate is RED at the
   documented λ; this is the constitution's stop condition.
2. **Add evidence-survival (and, where a dataset has gold evidence, gold-anchored
   correctness) as a CO-GATE for long-horizon pruning**, alongside Faithfulness/
   Answer-Relevancy. The LLM-judged metrics alone reward focused-but-wrong
   answers under context dilution. Recorded in `docs/EVAL_FRAMEWORK.md`.
3. **Do NOT retune the documented λ=0.97 from this run.** Same discipline as
   ADR-0011: a 3-conversation/18-question sample characterizes a relationship; it
   does not justify changing a product default, and tuning λ to maximize a gold
   metric is the forbidden over-fitting. The sweep *informs* the future fix.
4. **Route the fix through the existing calibration work (ADR-0011).** The
   candidates — a horizon-aware / near-1 λ for the long-term-memory tier, and/or
   supersession suppression (orthogonal to decay) — must each re-pass this gate
   (evidence-survival + Faithfulness/Relevancy) before activation.

## Consequences

- Pruning ships nowhere; the proxy continues to forward full context (Phase-1
  measurement behaviour). No regression — pruning was never wired in.
- `eval:locomo` is a repeatable, sampled, cost-bounded Tier-A gate. The numbers
  above are reproducible (deterministic sampling; fixed `now` rule).
- The eval gate now has a documented blind spot + its mitigation (co-gate on
  evidence survival), so future pruner changes are measured against retrieval
  truth, not just judge-perceived fluency.
- The corpus stays out of git (CC-BY-NC); only code + this ADR carry the result.

## Alternatives Considered

- **Gate on Faithfulness/Answer-Relevancy only (as written).** Rejected as
  sufficient: Finding 2 shows it nearly green-lit a 1.4%-evidence pruner. Kept as
  one of several co-gates, not the sole gate.
- **Declare PASS on the favourable aggregate (pruned ≥ baseline).** Rejected —
  dishonest: it would ship a pruner that loses 98.6% of evidence. The aggregate
  is an artifact of baseline context-dilution, not pruning quality.
- **Retune λ→1.0 now and re-run to green.** Rejected — over-fitting + a product
  default change on a tiny sample (ADR-0011 discipline). λ=1.0's strength is
  recorded as a calibration input, not adopted.
- **Commit the LoCoMo data for reproducibility.** Rejected — CC-BY-NC forbids
  redistribution in a commercial repo; gitignored + fetched on demand instead.
