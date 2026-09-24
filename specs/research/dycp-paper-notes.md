# DyCP paper provenance notes

**Scope:** `plan.md` §2b paper-notes deliverable. This records external research for the v0.4 pruner and does not change runtime behavior or evaluation gates.

## REQ-1 — Source and method

WHEN the DyCP paper notes are filled, THE NOTES SHALL identify the paper version and describe its historical unit, scoring, span selection, and published hyperparameters. THE NOTES SHALL distinguish paper behavior from Stratum's separate-message encoding, gain default, and temporal decay.

## REQ-2 — Evidence and limits

WHEN published results are reported, THE NOTES SHALL name the benchmark, model, quality metric, latency metric, and paper result; THE NOTES SHALL NOT present them as Stratum measurements. THE NOTES SHALL record retrieval failure, judge scope, and cache-related deployment limitations.

## REQ-3 — Follow-up

WHEN adaptation choices are listed, THE NOTES SHALL preserve unchanged Tier-C and judged Tier-A release gates and name the focused comparisons needed before a default selector change.

## Acceptance

- `stratum/docs/paper-notes.md` has at least five substantive, sourced observations, including algorithm, τ/θ/λ distinction, LoCoMo and MT-Bench+ results, limitations, and adaptation choices.
- `plan.md` marks only the paper-notes checklist item complete.
