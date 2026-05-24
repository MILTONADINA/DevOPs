# Spec — Session 7 Stratum Merge + Combined-Project Audit

**Type**: Meta (no production deliverable; an audit producing a refined launch-readiness figure)
**Status**: Active — driving session 7 of Phase 2 Step 4
**Author**: Milton Adina (session 7 prompt)
**Date**: 2026-05-24

The Phase 2 area specs (A–H) are scoped to one engineering area each. This
spec covers session 7's meta-work: merging the Stratum upstream repository
into DevOPs as a subtree, then auditing the combined project to produce a
single-number launch-readiness figure with explicit methodology.

The session's deliverable is the audit, not new production code.

---

## REQ-S7-1 — Stratum subtree merge

THE SYSTEM SHALL merge `https://github.com/MILTONADINA/Stratum.git` into
the DevOPs repository at the `stratum/` prefix using `git subtree add`.

### AC-S7-1.1

WHEN the merge completes, THE SYSTEM SHALL preserve Stratum's full git
history (no `--squash`), keep `main` and `phase-2-security-depth`
untouched, and produce a clean working tree on a new branch
`stratum-merge`.

---

## REQ-S7-2 — Audit artifacts

THE SYSTEM SHALL produce five audit files at
`.workflow/state/stratum-audit/`:

1. `01-stratum-state.md` — Stratum's actual state (commits, LOC, what's implemented vs stub)
2. `02-overlap.md` — DevOPs ↔ Stratum claim/reality overlap; PB-11 entry
3. `03-integration.md` — Integration wiring cost (Option A / B / C scopes)
4. `04-gap-roadmap-deltas.md` — Proposed ROADMAP + GAP_61 deltas (PROPOSAL ONLY; not applied)
5. `05-launch-readiness.md` — Refined launch-readiness math with explicit methodology

### AC-S7-2.1

WHEN the five files exist at the specified paths, AND each opens with a
properly-titled H1 heading naming its scope, THE SYSTEM SHALL be
considered to have produced the audit deliverable.

---

## REQ-S7-3 — Public launch-readiness artifact

THE SYSTEM SHALL maintain `docs/LAUNCH_READINESS.md` as the public,
tracked, durable source-of-truth for launch readiness. The file is
refreshed each session that changes the v0.2.0 envelope or the
methodology.

### AC-S7-3.1

WHEN session 7 Batch 3 completes, `docs/LAUNCH_READINESS.md` SHALL
contain BOTH the v0.2.0 figure (90% per refined methodology) AND the
full-project-completion figure range (8–17% depending on Phase 3
option), with explicit math shown for each.

---

## REQ-S7-4 — No premature ROADMAP / GAP_61 edits

THE SYSTEM SHALL NOT edit `governance/changelog/ROADMAP.md` or
`docs/GAP_61_COVERAGE_MATRIX.md` in session 7. Proposed deltas are
documented in audit file `04-gap-roadmap-deltas.md` and surfaced for
user approval. Edits are applied in a future session after explicit
go-ahead.

### AC-S7-4.1

WHEN session 7 completes, `git log` SHALL show zero commits touching
`governance/changelog/ROADMAP.md` or `docs/GAP_61_COVERAGE_MATRIX.md`
on the `stratum-merge` branch.

---

## Scope boundary

This spec covers session 7 only. Phase 2 implementation (areas C, F,
A.11) is **out of scope**. Areas C and F resume in session 8 against
the refined launch-readiness plan; A.11 unblocks when C.05 ships.
