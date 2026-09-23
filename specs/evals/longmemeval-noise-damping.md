# LongMemEval judged-gate noise damping

**Source**: `.workflow/state/polish-backlog.md` PB-41/PB-42,
`stratum/docs/decisions/0015-tier-aware-scale-invariant-decay.md`.
**Date**: 2026-09-23.

## REQ-1 — Repeated scoring

WHEN `LONGMEMEVAL_REPEATS` is a positive integer R, THE SYSTEM SHALL score
both the full-context baseline and the pruned context R times per question,
averaging each metric before applying the existing Tier-A gate. Without the
setting, R SHALL be one.

## REQ-2 — Cost and noise visibility

WHEN reporting the judged run, THE SYSTEM SHALL show the R-scaled maximum
model-call budget and the sample standard deviation of each averaged metric.
The reported evidence-survival score SHALL remain deterministic and unaveraged.

## REQ-3 — Offline verification

WHEN answerer and judge fakes are injected, THE SYSTEM SHALL verify R=1 and
R=2 call counts, means, and standard deviations without a model download or
an API call.

## Acceptance criteria

- **AC-1**: R=2 invokes two answerer and two judge calls for each context,
  and the gate consumes their mean scores.
- **AC-2**: R=1 preserves the existing single-shot path.
- **AC-3**: the printed upper-bound call count scales with R, and standard
  deviation is reported when R>1.
