# Spec — Session 12 Phase A: Q8 test-runner baked + PB-13 one-shot retry + LAUNCH_READINESS refresh

**Type**: Meta (no production deliverable; a spec-update + retry-and-document operation)
**Status**: AUTHORED 2026-05-25 — Phase A executed; PB-13 retry FAILED at scheduler (FOURTH consecutive); Phase B (P0-A scaffolding) DEFERRED on streaming-crash fixture gap
**Author**: Milton Adina (session 12 prompt)
**Date**: 2026-05-25

Session 11 Phase A baked Q1-Q7 into spec §7 and surfaced the test-runner ambiguity (existing `stratum/package.json` scaffold declares jest, while the prompt called for vitest). Session 12 closes that ambiguity by binding Q8 = jest and re-attempts PB-13 closure once per the user's policy.

This meta-spec anchors three deliverables:

1. Q8 (test runner = jest) added to spec §7 as the eighth binding decision
2. PB-13 one-shot retry result honestly recorded (FOURTH scheduler-block; PB-13.3 escalation logged)
3. LAUNCH_READINESS.md refreshed against post-Session-12 state

The session's Phase A deliverable is the spec patch + LR refresh + claim emission, not new code.

---

## REQ-S12A-1 — Q8 baked into spec §7

THE SYSTEM SHALL extend §7 of `.workflow/state/plans/stratum-phase-0-capture.md` with the user-confirmed Q8 binding decision: test runner = jest.

### AC-S12A-1.1

WHEN §7 contains a Q8 entry with `DECIDED: jest` prefix, AND a rationale referencing `stratum/package.json`'s existing `jest ^29.7.0` + `ts-jest ^29.1.5` + `jest:{}` config-block scaffold, AND a carry-forward note that jest is also binding for Phase 1 + Phase 3 specs (no per-phase test-runner divergence), THE SYSTEM SHALL be considered to have committed Q8 as a binding decision.

### AC-S12A-1.2

WHEN §9 (pre-merge checklist) has been updated from "Q1-Q7" to "Q1-Q8" (so reviewers verify Q8 alongside the prior seven), THE SYSTEM SHALL be considered to have integrated Q8 into the per-PR review surface.

---

## REQ-S12A-2 — PB-13 one-shot retry result honestly recorded

THE SYSTEM SHALL append the Session 12 ONE-shot retry result to PB-13's entry in `.workflow/state/polish-backlog.md` per the prompt's no-retry policy.

### AC-S12A-2.1

WHEN PB-13's entry contains a "Session 12 Phase A re-attempt (PB-13.3)" subsection capturing: workflow run ID (`26416394799`), duration (~5 sec), conclusion (`failure`), step count (0), the explicit escalation language ("user-side action required at github.com/settings/billing/spending_limit"), AND the language "do NOT re-attempt PB-13 in subsequent sessions until user explicitly confirms the spending-limit setting", THE SYSTEM SHALL be considered to have honestly recorded the FOURTH consecutive failure without claiming closure.

### AC-S12A-2.2

WHEN run meta is archived at `.workflow/state/security/pb13-run-26416394799-meta.txt`, THE SYSTEM SHALL be considered to have preserved the audit trail for downstream review.

---

## REQ-S12A-3 — LAUNCH_READINESS.md refreshed against post-Session-12 state

THE SYSTEM SHALL update `docs/LAUNCH_READINESS.md` with figures reflecting Session 12 Phase A outcomes + the Phase B deferral.

### AC-S12A-3.1

WHEN the headline-guidance H2 reflects Session 12 Phase A as the most recent refinement, AND the v0.2.0 figure stays at ~95% (FOURTH PB-13 failure cited), AND the full-project figure recomputes against the new total-done denominator (~155h of 996h ≈ ~16%), AND a "Session 12 Phase A outcomes" summary subsection enumerates the Q8 baking + PB-13 retry + Phase B deferral, THE SYSTEM SHALL be considered to have refreshed launch math honestly.

### AC-S12A-3.2

WHEN the document records the Phase B deferral cause (CHANGELOG streaming-crash entry fictional; capture-session.ts has no streaming code path; crash-replication fixture cannot be reconstructed) as a strategist-loop action item, THE SYSTEM SHALL be considered to have surfaced the blocker rather than improvising past it.

---

## Scope boundary

This meta-spec covers Session 12 Phase A only. The Q8 spec patch + PB-13 retry meta + LR refresh are the operational deliverables; this meta-spec exists solely to anchor claim 094 to a `specs/...` path (per claim-validator constraint `spec_ref.startsWith("specs/")`).

Session 12 Phase B (P0-A test harness scaffolding) is DEFERRED out of this meta-spec's scope pending strategist-loop resolution of the streaming-crash fixture gap. Phase B may still advance on non-streaming surfaces (proxy passthrough, tool-use response, countTokens mocking, fastify lifecycle) once the user clarifies whether to: (a) defer all streaming work to a later phase, (b) synthesize a crash hypothesis from capture-session.ts code-path analysis, or (c) scope P0-B as the first streaming implementation rather than a crash fix.

Session 12 Phase C (baton + session-handoff updates) is out of this meta-spec's scope (gitignored state files do not require claim anchoring).
