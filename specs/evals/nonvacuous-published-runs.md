# Nonvacuous published evaluation runs

**Scope:** `plan.md` §3e v0.4 Tier-A release gate and
`stratum/docs/EVAL_FRAMEWORK.md` §Running the Eval Suite. The separate
LoCoMo and LongMemEval judged runners currently return success if filtering
selects no questions, which can make a missing evidence signal look green.

## REQ-1 — Empty LoCoMo selection fails closed

WHEN the LoCoMo runner has a dataset and judged provider but its selected
answerable, evidence-resolved question set is empty, IT SHALL report that no
questions were evaluated and exit nonzero before any model or encoder call.
It SHALL NOT report a passing Tier-A result.

## REQ-2 — Empty LongMemEval selection fails closed

WHEN the LongMemEval runner has a dataset and judged provider but its selected
evidence-bearing question set is empty, IT SHALL report that no questions were
evaluated and exit nonzero before any model or encoder call. IF filtering or
runtime skips produce zero scored outcomes, IT SHALL also exit nonzero and
SHALL NOT report a passing Tier-A result.

## Acceptance

- Each runner fails on a valid inline dataset when a supported category/type
  filter selects zero questions. The test uses a configured local provider
  that is never called.
- A normal nonempty selection still reaches the existing judged path; this
  change does not alter the pruner, data, or thresholds.
