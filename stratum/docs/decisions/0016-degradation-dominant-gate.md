# ADR-0016: The Eval Gate is Degradation-Dominant; Absolute Floors are Pruning-Attributable Only

**Date:** 2026-05-29
**Status:** Accepted — PB-43 (degradation-dominant metrics) AND PB-39 (evidence-survival co-gate) both implemented + tested (2026-05-29)

## Context

Two real runs exposed that the gate's pass/fail logic (`compare.ts`) measures the
wrong thing in BOTH directions:

- **ADR-0014 (false PASS):** at λ=0.97 the pruner retained **1.4%** of gold evidence,
  yet scored Faithfulness/Answer-Relevancy ≥ baseline (it bluffed a crisp answer from
  recent context) — 15/18 scenarios "passed." The metrics didn't see the retrieval
  failure.
- **ADR-0015 (false FAIL):** the calibrated scale-invariant config retained **87.5%**
  evidence with aggregate Faithfulness degradation **+0.028 (within the <5% bar)**,
  yet passed only 10/18 — because the per-scenario gate hard-fails whenever the
  PRUNED score is below an absolute floor (faith ≥0.90, relev ≥0.88) **regardless of
  the baseline**. Several failures were floor trips where pruned == baseline (zero
  degradation) or where the BASELINE itself was below the floor (the "Oct 2023
  setback" question scores faith 0.50/0.70 at FULL context — the answerer/judge can't
  ace it even un-pruned).

The constitution's stated criterion (stratum `.claude/CLAUDE.md` "Eval Before Ship")
is **"<5% degradation on Faithfulness, <5% on Answer Relevancy."** It is a DEGRADATION
criterion. The absolute floors come from DeepEval's default thresholds and were being
applied as an independent hard gate on the pruned score — which conflates *"did
pruning hurt?"* (a pruning property) with *"is the answer good in absolute terms?"* (a
question/answerer/judge property the pruner does not control).

## Decision

### PB-43 — degradation-dominant metric gating (implemented here)

A metric FAILS iff:
1. **Degradation exceeds tolerance:** `baseline − pruned ≥ maxDegradation`. *(The
   constitution's criterion — primary.)* OR
2. **Pruning dropped it below the floor:** `pruned < min AND baseline ≥ min`. *(The
   floor failure is pruning-attributable only when the baseline CLEARED the floor.)*

A metric does **not** fail as a pruning failure when `pruned < min AND baseline < min`
— the task/answerer/judge can't meet the floor even at full context. This is recorded
as a `baselineBelowFloor` DIAGNOSTIC (surfaced in the report), not silently dropped:
it signals an answerer/judge-quality ceiling or a too-hard question, which is a
different problem from pruning.

This change is **backward-compatible**: every existing gate test uses a baseline that
clears the floor, so all preserve their verdict. It is **not weakening-to-pass**: the
calibrated config (ADR-0015) STILL FAILS **11/18** under the new logic (only one
scenario — faith 0.85/0.85, zero degradation — correctly flips from fail to pass), and
every real degradation (e.g. conv-41#12 faith 0.50/1.00) still fails.

### PB-39 — evidence-survival co-gate (implemented)

Degradation-dominant metrics alone still permit the ADR-0014 false-PASS (a bluffing
pruner scores ≈ baseline). So for datasets that ship gold evidence (LoCoMo,
LongMemEval), the suite ALSO gates on **evidence survival** (gold-evidence turns kept
÷ total — deterministic, no judge). A scenario fails if survival is below a floor.
The floor is an explicit, documented threshold (`evidenceSurvivalMin`), tracked as a
calibration item — NOT used to auto-tune λ. Adding it makes the gate STRICTER
(balancing PB-43's re-attribution), so the combined gate is more correct in BOTH
directions: it neither false-passes a 1.4%-evidence pruner nor false-fails an
87.5%-evidence one.

## Consequences

- The gate now matches the constitution's stated criterion (degradation), and floor
  failures are correctly attributed to pruning vs. task/answerer quality.
- Pruning still does NOT ship: the calibrated config remains RED (11/18) even after
  this fix + needs the evidence co-gate + a second benchmark (PB-41) + a larger,
  noise-damped sample (PB-42) before any ship decision.
- `MetricVerdict` gains a `baselineBelowFloor` diagnostic; the report surfaces it so a
  sub-floor baseline is never mistaken for a clean pass or a pruning fail.
- A future GREEN now means something trustworthy: pruning preserved the evidence AND
  did not degrade the answer beyond tolerance, judged against the right reference.

## Alternatives Considered

- **Keep absolute floors as an independent hard gate.** Rejected: it false-fails an
  87.5%-evidence pruner on questions the baseline can't answer either (ADR-0015), and
  the constitution's criterion is degradation, not an absolute floor.
- **Drop the floors entirely, gate on degradation only.** Rejected: an absolute floor
  IS meaningful when pruning pushes a good baseline answer below it (case 2 above) —
  dropping it would miss real "pruning made a faithful answer unfaithful" failures.
- **Relax the floor values (e.g. 0.90 → 0.80).** Rejected — that IS the eval-vacuity
  anti-pattern the project guards against (ADR-0011); the issue is mis-ATTRIBUTION,
  not the floor's level.
- **Lower the evidence-survival expectation to make the calibrated config pass.**
  Rejected — over-fitting; the gate stays RED honestly until calibration + breadth.
