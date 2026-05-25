# Spec — Session 10 Stratum Phase 0 Capture Spec Authorship

**Type**: Meta (no production deliverable; an implementation-spec authorship producing the Phase 0 plan)
**Status**: AUTHORED 2026-05-25 — awaiting user answers on §7 open questions in the implementation spec before Session 11 implementation begins
**Author**: Milton Adina (session 10 prompt)
**Date**: 2026-05-25

The Phase 2 area specs (A–H) were per-engineering-area. This meta-spec covers Session 10 Phase C's authorship of the Stratum Phase 0 implementation spec, which lives at `.workflow/state/plans/stratum-phase-0-capture.md`.

The session's Phase C deliverable is the implementation spec itself, not new code.

---

## REQ-S10C-1 — Implementation spec authored

THE SYSTEM SHALL produce an implementation spec at `.workflow/state/plans/stratum-phase-0-capture.md` covering Stratum Phase 0 (Capture).

### AC-S10C-1.1

WHEN the spec file exists, AND contains all 9 required H2 sections (§1 Scaffold reality, §2 Phase 0 target, §3 REQ decomposition, §4 ACs per REQ, §5 Cross-area constraints, §6 Out-of-scope, §7 Open questions, §8 Lessons-in-force, §9 Pre-merge checklist), AND decomposes Phase 0 into 7 sub-areas (P0-A through P0-G) totaling within the 30-80h Option B envelope tolerance, THE SYSTEM SHALL be considered to have produced the spec deliverable.

---

## REQ-S10C-2 — README pointer maintenance

THE SYSTEM SHALL update `memory/stratum/README.md` with a pointer to the new Phase 0 spec without changing the scaffold-reality statement or the 0% Phase 0 marker.

### AC-S10C-2.1

WHEN `memory/stratum/README.md` contains a new H2 section pointing at `.workflow/state/plans/stratum-phase-0-capture.md`, AND retains the existing scaffold-reality H2 + the 0% Phase 0 entry in the 7-phase taxonomy table, THE SYSTEM SHALL be considered to have maintained README integrity (spec authorship ≠ implementation; the README must not falsely imply Phase 0 is underway).

---

## REQ-S10C-3 — Open questions enumerated, not improvised

THE SYSTEM SHALL surface §7 open questions (Q1-Q7) explicitly in the implementation spec, blocking Session 11 implementation start until user-confirmed answers exist.

### AC-S10C-3.1

WHEN the spec's §7 contains exactly 7 numbered open questions (Q1-Q7), each with concrete alternative options (a/b/c/d) and no improvised pre-selected answer, THE SYSTEM SHALL be considered to have honored the surface-don't-assume discipline (saved-memory `feedback_polish_backlog.md` family).

---

## Scope boundary

This meta-spec covers Session 10 Phase C only. The implementation spec at `.workflow/state/plans/stratum-phase-0-capture.md` is the operational deliverable; this meta-spec exists solely to anchor claim 091 to a `specs/...` path (per claim-validator constraint `spec_ref.startsWith("specs/")`).

Session 11 begins after user answers Q1-Q7 in the implementation spec. Session 11+ work is out of this meta-spec's scope.
