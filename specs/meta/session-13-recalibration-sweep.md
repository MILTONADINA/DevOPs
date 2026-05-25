# Spec — Session 13 Phase A: recalibration sweep under production-grade quality bar

**Type**: Meta (no production deliverable; spec recalibration + validator-rot remediation + polish-backlog closures)
**Status**: AUTHORED 2026-05-25/26 — Phase A executed under production-grade quality bar (no "personal-tool" framing, no deferring without architectural justification)
**Author**: Milton Adina (session 13 prompt)
**Date**: 2026-05-25/26

Session 12 baked Q8 = jest under zero-churn / personal-tool prior; Session 13 recalibrates under production-grade prior. The session also surfaces the fictional-CHANGELOG honesty fix, re-scopes P0-B as greenfield streaming, and cleans up the validator-drift items the user pre-authorized as acceptable carry-forward in earlier sessions but now wants resolved under the higher quality bar.

---

## REQ-S13A-1 — Q8.1 amendment baked into spec §7

THE SYSTEM SHALL extend §7 of `.workflow/state/plans/stratum-phase-0-capture.md` with the Q8.1 user-confirmed amendment: test runner = vitest (supersedes Q8 = jest).

### AC-S13A-1.1

WHEN §7 contains a Q8.1 subsection with `AMENDED: vitest` prefix, a rationale referencing ESM-first / no ts-jest brittleness / ~3-5× faster execution / cleaner mocking ergonomics, AND Q8 (jest) is RETAINED as audit trail (not removed), AND a `SUPERSEDED by Q8.1` marker on the Q8 entry, AND §9 pre-merge checklist references "Q1-Q8 + Q8.1", THE SYSTEM SHALL be considered to have committed Q8.1 as a binding amendment with full audit trail preservation.

---

## REQ-S13A-2 — §3 P0-B re-scoped from crash-fix to greenfield streaming

THE SYSTEM SHALL re-scope §3's P0-B sub-area from "fix CHANGELOG crash" to "greenfield streaming implementation."

### AC-S13A-2.1

WHEN §3 P0-B entry says "Streaming support implementation (greenfield)" or equivalent, references the Session 13 re-scope (not "fix CHANGELOG crash"), AND the effort estimate is ~16-20h (midpoint 18h baked into the table), AND the P0 envelope total is revised upward to ~62h (was ~52h), THE SYSTEM SHALL be considered to have re-scoped honestly with denominator-tightening rather than progress-padding.

### AC-S13A-2.2

WHEN §1 of the spec no longer references a "Streaming-response crash in capture script" as a known defect (that reference traced to a fictional CHANGELOG entry), AND the corrected text accurately describes capture-session.ts as having no streaming code path with streaming as greenfield P0-B work, THE SYSTEM SHALL be considered to have applied the honesty fix to §1's scaffold-reality section.

---

## REQ-S13A-3 — §4 acceptance criteria clarified under production-grade bar

THE SYSTEM SHALL clarify §4 acceptance criteria to (a) move streaming tests from P0-A to P0-B, (b) set production-grade coverage thresholds on P0-A, (c) enumerate P0-A's 11 test files, and (d) author new P0-B ACs covering greenfield streaming.

### AC-S13A-3.1

WHEN §4 P0-A ACs include a coverage-threshold AC (statements ≥85%, branches ≥80%, functions ≥90%, lines ≥85%), AND a scope-guard AC stating streaming tests/fixtures are EXCLUDED from P0-A (move to P0-B), AND a test-set-enumeration AC listing the 11 test files with their coverage areas, THE SYSTEM SHALL be considered to have clarified P0-A's acceptance criteria under the production-grade bar.

### AC-S13A-3.2

WHEN §4 P0-B ACs author at least 4 new acceptance criteria covering: streaming detection (`stream: true` OR `Accept: text/event-stream`), SSE forwarding preserving streaming semantics with ≤50ms p95 first-token-latency overhead, session-JSON accumulation from chunk events, comprehensive stream-error handling (network drop, malformed chunk, client abort, anthropic-side error event), THE SYSTEM SHALL be considered to have authored P0-B acceptance criteria for greenfield streaming.

---

## REQ-S13A-4 — CHANGELOG cleanup (root-cause fix for Session 12 unexecutable prompt)

THE SYSTEM SHALL remove `stratum/CHANGELOG.md`'s "Format Reference" example block (which contained a fictional crash entry misread upstream as a real defect) and replace with a single Keep-a-Changelog link.

### AC-S13A-4.1

WHEN `stratum/CHANGELOG.md` no longer contains a "## Format Reference" H2 with the example markdown block, AND the file references Keep-a-Changelog (https://keepachangelog.com/en/1.1.0/) as the canonical format, AND the `[Unreleased]` section has a `### Changed` entry documenting the removal + rationale (downstream contamination of the fictional crash entry), THE SYSTEM SHALL be considered to have cleaned up the documentation hazard.

---

## REQ-S13A-5 — Validator-rot remediation (PB-19, PB-20, PB-22 closed)

THE SYSTEM SHALL close PB-19, PB-20, and PB-22 via methodology refactors / pure-Node rewrites of the rotted claim checks, so that the validator returns all three to valid.

### AC-S13A-5.1

WHEN `req-S7-stratum-audit.js` (claim 081 — PB-19) asserts methodology rather than frozen figures (any v0.2.0 + full-project percentage present; effort-hours-weighted language; Option B locked; explicit ratio math), AND the check returns exit 0 against current LR state, THE SYSTEM SHALL be considered to have closed PB-19.

### AC-S13A-5.2

WHEN `req-B3-full-asi01-fixture.js` (claim 073 — PB-20) no longer shells out to `python3`, instead performs pure-Node structural validation (harness.py declares `model_callback` + canonical/disregard/system-prefix markers + goal-hijack + benign paths; test_harness.py declares ≥5 test methods + imports `model_callback` + asserts on PWNED), AND the check returns exit 0 in environments without Python on PATH, THE SYSTEM SHALL be considered to have closed PB-20.

### AC-S13A-5.3

WHEN `req-session-11-spec-resolution.js` (claim 093 — PB-22) asserts methodology rather than Session-11-specific frozen strings (Session 11 reference present, billing-annotation pattern, scheduler-fail sub-10-second pattern, at least one workflow run ID matching `\b264\d{8}\b`, v0.2.0 + full-project figures, methodology language), AND the check returns exit 0 against current state, THE SYSTEM SHALL be considered to have closed PB-22.

---

## REQ-S13A-6 — PB-14 closure (actions/setup-node@v5 SHA bump)

THE SYSTEM SHALL bump `.github/workflows/ci.yml`'s `actions/setup-node@v4` reference to `actions/setup-node@<v5.0.0-SHA>` with explicit SHA pin per AST08 discipline.

### AC-S13A-6.1

WHEN `.github/workflows/ci.yml` contains `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444  # v5.0.0` (verified as the v5.0.0 tag ref via `git ls-remote --tags`), AND no other `actions/setup-node@v4` references remain in `.github/workflows/`, THE SYSTEM SHALL be considered to have closed PB-14.

---

## REQ-S13A-7 — PB-15 closure (GAP_61 row re-targeting)

THE SYSTEM SHALL re-target the 6 GAP_61 rows from PB-15 to their actual phase homes (Phase 4 or Phase 6), removing the Phase-2-hangover labels.

### AC-S13A-7.1

WHEN rows 4, 6, 28, 32, 33, 54 of `docs/GAP_61_COVERAGE_MATRIX.md` have their Phase column updated per Session 13 triage (row 4 → Phase 4, row 6 → 1+4, row 28 → 1+6, row 32 → 1+4, row 33 → 1+4, row 54 → 1+4), AND each row's "Phase" column carries an inline `re-targeted Session 13` note with rationale, THE SYSTEM SHALL be considered to have closed PB-15.

---

## REQ-S13A-8 — PB-21 triage outcome documented (stays coupled to PB-13)

THE SYSTEM SHALL document the Session 13 triage decision that PB-21 stays coupled to PB-13 (no honest decoupling available).

### AC-S13A-8.1

WHEN PB-21's entry in `.workflow/state/polish-backlog.md` contains a "Session 13 T-A8 triage outcome" subsection explaining that the claim's "every entry's recorded sha256 matches the SKILL.md file on disk" assertion IS structural integrity (not historical attestation), AND refactoring to a weaker assertion would misrepresent what the manifest proves, AND the only honest closure path is the manifest sha256 + .sig + .bundle refresh via release-sign.yml (which requires PB-13), THE SYSTEM SHALL be considered to have documented the triage outcome.

---

## REQ-S13A-9 — PB-16 promotion to dedicated session

THE SYSTEM SHALL promote PB-16 (git tag signing) to a dedicated closure session, gated on user-side cryptographic key state.

### AC-S13A-9.1

WHEN PB-16's entry in `.workflow/state/polish-backlog.md` contains a "PROMOTED to dedicated session" marker with explicit closure unit (user generates GPG/SSH signing key + uploads public key to GitHub + provides fingerprint, then agent configures `user.signingkey` + `tag.gpgsign = true`), AND the rationale references architectural blocker on user-side private-key custody (NOT "personal-tool framing"), AND the gating condition for the dedicated session is documented (user message confirming key generation + GitHub upload + fingerprint), THE SYSTEM SHALL be considered to have promoted PB-16 honestly.

---

## REQ-S13A-10 — LAUNCH_READINESS refreshed under new envelope + production-grade bar

THE SYSTEM SHALL update `docs/LAUNCH_READINESS.md` with figures reflecting Session 13 Phase A outcomes and the new P0-B envelope.

### AC-S13A-10.1

WHEN the headline-guidance H2 reflects Session 13 Phase A as the most recent refinement, AND a "Quality bar (Session 13+ binding)" section is present with production-grade requirements, AND the v0.2.0 figure stays at ~95% (PB-13 unchanged but no longer blocking downstream phases), AND the full-project figure recomputes against the new envelope (~158h / ~1006h ≈ ~16%), AND the math methodology explicitly notes the P0-B envelope grew from 8h to 18h (denominator-tightening), AND a "Session 13 Phase A outcomes" summary enumerates all Q8.1 / P0-B / §4 / CHANGELOG / PB-14 / PB-15 / PB-16 / PB-19 / PB-20 / PB-21 / PB-22 / PB-13 outcomes, THE SYSTEM SHALL be considered to have refreshed launch math honestly under the production-grade bar.

---

## Scope boundary

This meta-spec covers Session 13 Phase A only. The recalibration sweep + validator-rot remediation + PB closures are the operational deliverables; this meta-spec exists to anchor claim 095 (and 096, 097, 098 as separate emissions) to a `specs/...` path per claim-validator constraint.

Session 13 Phase B (vitest migration + comprehensive P0-A test coverage on `stratum-phase-0-capture` long-lived branch) is out of this meta-spec's scope and has its own claim (099, conditional on target-tier completion).

Session 13 Phase C (baton + session-handoff updates) is out of this meta-spec's scope (gitignored state files do not require claim anchoring).
