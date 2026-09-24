# Full published Tier-A orchestration

**Scope:** `plan.md` §3e v0.4 and `stratum/docs/EVAL_FRAMEWORK.md` §Running the
Eval Suite. `test:eval` currently stops after Tier-B and reports that published
Tier-A is not orchestrated. Standalone published runners default to samples.

## REQ-1 — Run every required tier in the main command

WHEN `test:eval` runs without `--fast` and Tier-C and judged Tier-B pass, THE
RUNNER SHALL run LoCoMo and LongMemEval at the documented pruning defaults in
that order. It SHALL invoke their full-coverage mode and SHALL return success
only if both published gates pass under a non-exploratory Claude provider.
IF either gate fails or throws, THEN the main command SHALL exit nonzero and
name that gate. `--fast` SHALL continue to run Tier-C and Tier-B only.
IF judged Tier-B produces zero scored scenarios, THEN the main command SHALL
exit nonzero before invoking Tier-A.

## REQ-2 — Count every published question in full mode

WHEN full-coverage mode runs, LoCoMo SHALL use all ten conversations and judge
all 1,540 answerable category-1-through-4 questions; LongMemEval SHALL use the
500-question haystack, not the evidence-only oracle, and judge all 500
questions. The runners SHALL refuse a missing, partial, or malformed corpus,
and SHALL report selected, scored, evidence-labeled, and unlabeled counts. A
question without a complete usable gold-evidence label SHALL still receive
judged Faithfulness and Answer Relevancy; it SHALL have no evidence-survival
score rather than an invented perfect score. IF fewer questions are scored
than selected, THEN the full gate SHALL exit nonzero. The final verdict SHALL
label full coverage as full, not sampled. Standalone sampled mode SHALL keep
its current selection defaults.

## REQ-3 — Preserve gate meaning

WHEN a full published gate reports a verdict, IT SHALL apply the existing
per-question thresholds and evidence-survival floor to every usable label.
It SHALL label a local model result exploratory, never a release pass. It
SHALL leave request pruning disabled until Tier-C, both full published judged
gates, and one-week real-use quality pass.

## REQ-4 — Keep operator guidance current

WHEN full-suite orchestration is merged, THE v0.4 plan, evaluation guide, and
launch-readiness checkpoint
SHALL describe default `test:eval` as invoking both complete published gates
after Tier-C and Tier-B. They SHALL distinguish implemented orchestration from
an actual passing judged run, and SHALL continue to name the red Tier-C gate,
CI scheduling, and real-use validation as open work.

## Acceptance

- Failing-first offline tests show the default main command does not invoke
  Tier-A after a green Tier-C/Tier-B result, and that sampled standalone
  selection omits unlabeled questions.
- Offline tests with inline corpus shapes verify full question counts,
  unscored evidence handling, corpus incompleteness rejection, and unchanged
  standalone sampled defaults. No paid provider is called by tests.
- Focused tests, typecheck, targeted lint/format, and structured proof pass.
