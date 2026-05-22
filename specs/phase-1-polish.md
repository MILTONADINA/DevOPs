# Phase 1 Polish

**Spec ID**: process/phase-1-polish
**Status**: approved
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

The Phase 1 validation session (`specs/phase-1-validation.md`) surfaced two
HIGH-severity defects that would degrade the GitHub push artifact and break
Prompt 3's claim-validator invocation:

- **PB-1**: `lifecycle/build/PHASE.md` is silently excluded from git by an
  over-broad `**/build/` rule in `.gitignore`, causing the seven-phase
  lifecycle definitions to ship as six.
- **PB-2**: `package.json`'s `scripts.validate:claims` calls
  `node ./verification/claim-validator.js`, which does not exist (only the
  `.ts` source ships, and there is no build step or tsconfig).

This spec scopes a bounded "Phase 1 polish" session that fixes **exactly
those two defects** — and no others from the polish backlog — before the
GitHub push (Prompt 2) runs.

## Out of scope

- The three remaining polish-backlog items: PB-3 (missing `hooks/test-all.sh`),
  PB-4 (AGENTS.md skills catalog drift), PB-5 (no `@types/node` declared),
  PB-6 (`scripts/devops-cli.js` mode observation). All deferred to a single
  v0.1.0 polish commit AFTER the GitHub push.
- Contract files (`AGENTS.md`, `CLAUDE.md`, `constitution/*.md`).
- Adding a `tsconfig.json` or TypeScript build step.
- Squashing or rewriting the prior validation commits (six commits stay intact).
- Any Phase 2 deliverable.

## Actors and data

- **Primary actors**: validation agent (Claude Code), human reviewer
- **Data classes touched**: [x] none
- **Compliance scope**: [x] none

---

## Functional requirements (EARS)

### REQ-1 (Ubiquitous) — PHASE.md must be tracked
THE SYSTEM SHALL track the file `lifecycle/build/PHASE.md` in git so that the seven-phase lifecycle definitions ship complete in the published repository.

### REQ-2 (Ubiquitous) — validate:claims must work out of the box
THE SYSTEM SHALL ensure `npm run validate:claims` exits 0 on a clean checkout without manual workaround and validates every `.yml` file under `.workflow/proofs/`.

---

## Acceptance criteria

### AC-1.1 (maps to REQ-1)
**Given** the repository at HEAD after this polish session
**When** `git ls-files lifecycle/build/PHASE.md` is executed
**Then** the output contains the path `lifecycle/build/PHASE.md`.

### AC-1.2 (maps to REQ-1)
**Given** the repository at HEAD after this polish session
**When** `git check-ignore -v lifecycle/build/PHASE.md` is executed
**Then** the command exits with non-zero status (file is NOT ignored by any `.gitignore` rule).

### AC-2.1 (maps to REQ-2)
**Given** the repository at HEAD after this polish session
**When** `npm run validate:claims -- --no-rerun` is executed
**Then** the command exits 0 and the validator reports `N/N claims valid` for some N ≥ 12.

---

## Non-functional requirements

### NFR-1 — Surgical scope
- Exactly two new commits land in this session: one for REQ-1 (touching `.gitignore` + adding `lifecycle/build/PHASE.md`) and one for REQ-2 (touching `package.json`).
- No other files are modified.

### NFR-2 — Reproducibility
- Each new claim records a re-runnable `test_command`.
- The REQ-2 claim's `test_command` uses `--no-rerun` to prevent infinite recursion when `claim-validator --all` later re-runs it.

### NFR-3 — Continuity
- The six prior commits (`d36a58f`, `0e75e91`, `51c6ef9`, `9267397`, `8ff07c1`, `b483047`) remain intact and unrewritten.
- `claim-validator --all` passes for **all 12** claims (the original 10 + the two new ones).

---

## Decisions

- **REQ-1 fix is a `.gitignore` exception, not a deletion of `**/build/`.** The `**/build/` pattern is intentional — it legitimately ignores Webpack / Next.js / Rust build output in downstream consumer projects that adopt this gitignore as a template (the analyzer recommends it). Keeping the pattern preserves that protection; the `!lifecycle/build/` exception un-ignores only the lifecycle phase definitions.
- **REQ-2 fix uses `npx --yes tsx`, not a build step.** Adding a `tsconfig.json` + compile script is a larger change that belongs in the v0.1.0 polish commit (PB-5 covers it). The tsx swap is one line in `package.json` and fully restores `npm run validate:claims`.
- **REQ-2 claim's `test_command` is `node .workflow/proofs/_checks/req-12-validate-claims.js`**, which internally invokes `npm run validate:claims -- --no-rerun`. When `claim-validator --all` re-runs the REQ-2 claim's test, the `--no-rerun` flag prevents the inner validator from re-running the REQ-2 claim again, breaking the recursion. The default `npm run validate:claims` (with full rerun semantics) is demonstrated once during this session for AC-2.1 evidence.

---

## Open questions

None blocking.

---

## Implementation plan

This spec drives harness tasks T12–T15:
- T12 — this spec.
- T13 — REQ-1: edit `.gitignore`, `git add lifecycle/build/PHASE.md`, commit, emit claim-011.
- T14 — REQ-2: edit `package.json`, run `npm run validate:claims` to confirm exit 0, commit, emit claim-012.
- T15 — run `claim-validator --all`, confirm 12/12, update baton (`next_action` → Run prompt 2), stop.

## Test plan

| REQ | AC(s) | Claim ID |
| --- | --- | --- |
| REQ-1 | AC-1.1, AC-1.2 | `claim-2026-05-22-011` |
| REQ-2 | AC-2.1 | `claim-2026-05-22-012` |

---

## Change log

- 2026-05-22 miltonadina: created (bounded polish session between Prompt 1 and Prompt 2; user-approved scope: exactly PB-1 + PB-2).
