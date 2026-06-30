# Phase 1 — Ship to GitHub

**Spec ID**: process/phase-1-ship
**Status**: approved
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

This spec covers publishing the validated + polished Phase 1 build to a
private GitHub repository at `MILTONADINA/DevOPs`. It drives Prompt 2 of
the DevOPs methodology execution. Scope is **push + hygiene + polish-
backlog filing only** — no code changes, no history modification, and no
v0.1.0 tag.

The eight commits pushed are:

- `d36a58f` — feat: DevOPs Phase 1 (original build)
- `0e75e91` — docs(hooks): shell execution note (validation REQ-3)
- `51c6ef9` — fix(governance): YAML syntax in skill-evals registry (validation REQ-5)
- `9267397` — fix(verification): quote git revspec for shell safety (validation REQ-8)
- `8ff07c1` — chore(gitignore): ignore .prompts (validation REQ-9)
- `b483047` — docs(specs): add Phase 1 validation spec
- `275cf63` — fix(gitignore): track lifecycle/build/PHASE.md (polish REQ-1)
- `f178d05` — fix(verification): validate:claims via npx tsx + polish spec (polish REQ-2)

This spec file itself becomes the 9th commit and is pushed as a follow-up.

## Out of scope

- Tagging `v0.1.0` (deferred to a later session that resolves the
  remaining polish-backlog items: PB-3, PB-4, PB-5, PB-6).
- Any Phase 2 deliverable.
- Modifying any existing commit (no squash, no rebase, no amend, no force push).
- Enabling GitHub Advanced Security features (secret scanning, push
  protection) — requires a paid plan; logged and skipped per Prompt 2's
  best-effort rule.

## Actors and data

- **Primary actors**: validation agent (Claude Code), human reviewer
- **Data classes touched**: [x] none
- **Compliance scope**: [x] none

---

## Functional requirements (EARS)

### REQ-1 (Ubiquitous) — Private repository exists
THE SYSTEM SHALL ensure a private GitHub repository at `MILTONADINA/DevOPs` exists with the documented description.

### REQ-2 (Ubiquitous) — Push all 8 Phase 1 commits as-is
THE SYSTEM SHALL push the local `main` branch's eight Phase 1 commits to `origin/main` with no history modification (no squash, no rebase, no force).

### REQ-3 (Ubiquitous) — Repo hygiene applied
THE SYSTEM SHALL apply repository hygiene settings where the GitHub plan supports them — at minimum Dependabot vulnerability alerts, Dependabot automated security fixes, and branch protection on `main`. Plan limitations are logged and skipped.

### REQ-4 (Ubiquitous) — Polish backlog filed as GitHub Issues
THE SYSTEM SHALL file the four Phase 1 polish-backlog items (PB-3, PB-4, PB-5, PB-6) as GitHub Issues on `MILTONADINA/DevOPs`, each labeled `polish-backlog` and `v0.1.0`.

---

## Acceptance criteria

### AC-1.1 (maps to REQ-1)
**Given** the GitHub repository `MILTONADINA/DevOPs`
**When** `gh repo view MILTONADINA/DevOPs --json visibility` is executed
**Then** the output contains `"visibility":"PRIVATE"`.

### AC-2.1 (maps to REQ-2)
**Given** the local `main` branch at HEAD `f178d05` (before this ship spec is committed)
**When** `gh api repos/MILTONADINA/DevOPs/branches/main --jq '.commit.sha'` is executed
**Then** the returned SHA contains the prefix `f178d05` *or* is the HEAD of the ship spec commit (because this spec landed on top of `f178d05`).

### AC-2.2 (maps to REQ-2)
**Given** the GitHub repository
**When** `gh api 'repos/MILTONADINA/DevOPs/commits?per_page=100'` is executed
**Then** the count of returned commits is at least 8 (the original Phase 1 + 4 validation repair + 1 validation spec + 2 polish + this ship spec = 9 expected).

### AC-3.1 (maps to REQ-3)
**Given** the GitHub repository
**When** `gh api repos/MILTONADINA/DevOPs/branches/main --jq '.protected'` is executed
**Then** the output is `true`.

### AC-3.2 (maps to REQ-3)
**Given** the GitHub repository
**When** Dependabot vulnerability-alerts and automated-security-fixes endpoints are PUT
**Then** they return exit 0 (silent success body; verification via observable account state).

### AC-4.1 (maps to REQ-4)
**Given** the GitHub repository
**When** `gh api '/repos/MILTONADINA/DevOPs/issues?labels=polish-backlog&state=all' --jq 'length'` is executed
**Then** the output is at least 4.

---

## Non-functional requirements

### NFR-1 — No history modification
- Existing commits `d36a58f` through `f178d05` are pushed verbatim. No squash, no rebase, no amend, no force push.

### NFR-2 — Best-effort hygiene
- Plan-gated features (GHAS secret scanning, push protection) gracefully degrade to "logged and skipped" instead of stopping the session.

### NFR-3 — Reproducibility
- Each REQ has a re-runnable `test_command` that is a single self-contained `gh`/`node` invocation against the live GitHub API. The validator's `claim-validator --all` can re-verify any time the repo is reachable.

---

## Decisions

- **Ship spec committed AFTER the initial push.** The first push delivers the canonical 8 Phase 1 commits in their original state. The ship spec is added as a 9th commit and pushed separately so it traces the publication act itself, not the validated Phase 1 state.
- **`polish-backlog` and `v0.1.0` are the two labels on every PB issue.** `polish-backlog` says "this is deferred from a validation session." `v0.1.0` says "resolve before the next version tag."

---

## Test plan

| REQ   | AC(s)            | Claim ID                |
| ----- | ---------------- | ----------------------- |
| REQ-1 | AC-1.1           | `claim-2026-05-22-013`  |
| REQ-2 | AC-2.1, AC-2.2   | `claim-2026-05-22-014`  |
| REQ-3 | AC-3.1, AC-3.2   | `claim-2026-05-22-015`  |
| REQ-4 | AC-4.1           | `claim-2026-05-22-016`  |

---

## Change log

- 2026-05-22 miltonadina: created (drives Prompt 2 of the DevOPs methodology; ninth commit on `main`).
