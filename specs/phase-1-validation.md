# Phase 1 Validation

**Spec ID**: process/phase-1-validation
**Status**: approved
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

The Phase 1 commit `d36a58f` was authored in a Linux sandbox by an earlier
claude.ai session and delivered to this machine as a tarball. This spec
defines the structural and mechanical criteria the locally-extracted build
must satisfy before Phase 1 is treated as validated and the
GitHub push (Prompt 2) is authorized. Validation is read-mostly: it checks
that the directory tree, file counts, declared YAML/JSON/TypeScript
artifacts, hook shebangs, skill frontmatter, the claim-validator, and the
git working state are all self-consistent. The only file changes permitted
in this session are surgical repairs to defects this spec names; every
adjacent defect discovered is added to a "Phase 1 polish backlog" in the
validation report instead of being silently edited.

## Out of scope

- Behavioural verification of any individual hook, skill, or subagent (Phase 2+)
- Refactoring, renaming, or abstraction changes (P3 — surgical only)
- Editing contract files: `AGENTS.md`, `CLAUDE.md`, `constitution/*.md` (polish backlog)
- Authoring a `tsconfig.json` or adding a build step (polish backlog)
- Editing `package.json` script paths (polish backlog)
- Creating the missing `hooks/test-all.sh` referenced by `package.json` (polish backlog)
- Compiling `.ts` → `.js` (polish backlog)
- Porting `.sh` hooks to additional shells (Phase 2)
- Any Phase 2+ deliverable (security stack, signing, stack-specific skills, threat models)

## Actors and data

- **Primary actors**: validation agent (Claude Code), human reviewer
- **Data classes touched**: [x] none
- **Compliance scope**: [x] none

---

## Functional requirements (EARS)

### REQ-1 (Ubiquitous) — Directory structure
THE SYSTEM SHALL contain all nineteen documented top-level directories: `analyzer`, `constitution`, `cost-controls`, `docs`, `governance`, `hooks`, `lifecycle`, `mcp-configs`, `memory`, `meta-memory`, `modes`, `observability`, `sandbox`, `scripts`, `skills`, `slash-commands`, `subagents`, `templates`, `verification`.

### REQ-2 (Ubiquitous) — Committed file count
THE SYSTEM SHALL contain at least 150 git-tracked files at HEAD.

### REQ-3 (Ubiquitous) — Hook portability
THE SYSTEM SHALL document the execution path for bash hooks and ensure every hook script declares a portable bash shebang.

### REQ-4 (Ubiquitous) — TypeScript validity
THE SYSTEM SHALL ensure every `.ts` source under `verification/`, `analyzer/`, and `observability/` parses under `tsc --noEmit` with no diagnostics.

### REQ-5 (Ubiquitous) — YAML validity
THE SYSTEM SHALL ensure every `.yml` file in the repository parses as valid YAML.

### REQ-6 (Ubiquitous) — JSON validity
THE SYSTEM SHALL ensure every `.json` file in the repository parses as valid JSON.

### REQ-7 (Ubiquitous) — Skill manifest completeness
THE SYSTEM SHALL ensure every `SKILL.md` file declares YAML frontmatter containing a non-empty `name` field and a non-empty `description` field.

### REQ-8 (Unwanted behaviour) — Claim-validator schema enforcement
IF a claim artifact violates `verification/claim-schema.yml`, THEN THE SYSTEM SHALL cause the claim-validator to exit with non-zero status; AND WHEN a claim artifact conforms to the schema and its proof reproduces, THE SYSTEM SHALL cause the claim-validator to exit with status 0.

### REQ-9 (Ubiquitous) — Clean working tree with surgical repairs
THE SYSTEM SHALL present `git status` as clean except for the documented repair commits authored in this validation session.

### REQ-10 (Ubiquitous) — Validation report
THE SYSTEM SHALL produce a report at `.workflow/state/phase-1-validation.md` enumerating every check, every repair commit, every Phase 1 polish-backlog item with severity, and a Phase 2 readiness verdict.

---

## Acceptance criteria

### AC-1.1 (maps to REQ-1)
**Given** the extracted Phase 1 working tree
**When** the path of each of the nineteen documented top-level directories is tested for existence
**Then** all nineteen return true as directories.

### AC-2.1 (maps to REQ-2)
**Given** the Phase 1 commit `d36a58f` checked out at HEAD
**When** `git ls-files` is executed
**Then** the line count is ≥ 150.

### AC-3.1 (maps to REQ-3)
**Given** the current `docs/HOOKS.md` after the documentation repair
**When** the file is read
**Then** it contains an explicit statement that `.sh` hooks require a POSIX shell (bash/zsh).

### AC-3.2 (maps to REQ-3)
**Given** every `.sh` file under `hooks/` and `scripts/`
**When** the first line of each file is inspected
**Then** the first line is exactly `#!/usr/bin/env bash`.

### AC-4.1 (maps to REQ-4)
**Given** the six `.ts` files in `verification/`, `analyzer/`, and `observability/`
**When** they are passed to `tsc --noEmit --skipLibCheck` with `--target es2022 --module nodenext --moduleResolution nodenext`
**Then** the compiler exits 0 with no diagnostics.

### AC-5.1 (maps to REQ-5)
**Given** every `.yml` file in the repository
**When** each is parsed with a YAML parser
**Then** no parser exception is raised and the parsed document is non-null.

### AC-6.1 (maps to REQ-6)
**Given** every `.json` file in the repository
**When** each is parsed with `JSON.parse`
**Then** parsing returns a non-null value with no `SyntaxError`.

### AC-7.1 (maps to REQ-7)
**Given** every `SKILL.md` file under `skills/`
**When** the YAML frontmatter is parsed
**Then** the parsed object contains both a non-empty `name` and a non-empty `description`.

### AC-8.1 (maps to REQ-8)
**Given** a claim artifact deliberately violating `claim-schema.yml`
**When** `claim-validator` is invoked against it via `npx tsx verification/claim-validator.ts`
**Then** the process exits with non-zero status.

### AC-8.2 (maps to REQ-8)
**Given** a claim artifact conforming to `claim-schema.yml` whose `test_command` exits 0 when re-run
**When** `claim-validator` is invoked against it via `npx tsx verification/claim-validator.ts`
**Then** the process exits with status 0.

### AC-9.1 (maps to REQ-9)
**Given** the fifteen files originally shown as modified after extraction
**When** `git diff` is executed against them before the `core.filemode` repair
**Then** the diff shows only `old mode 100755` / `new mode 100644` and no content hunks.

### AC-9.2 (maps to REQ-9)
**Given** the working tree after the `git config --local core.filemode false` and `.gitignore` repairs have been applied and committed
**When** `git status --porcelain` is executed
**Then** the output is empty.

### AC-10.1 (maps to REQ-10)
**Given** the validation session has reached close-out
**When** `.workflow/state/phase-1-validation.md` is opened
**Then** it contains sections enumerating every REQ result, every repair commit SHA, every Phase 1 polish-backlog item with severity, and a Phase 2 readiness verdict.

---

## Non-functional requirements

### NFR-1 — Reproducibility
- Every check command is captured in its claim's `test_command` and is re-runnable from the repository root.
- Each check's stdout+stderr is captured to `.workflow/proofs/<claim-id>-test.log`.

### NFR-2 — Observability
- Each claim records `git_sha`, `files_changed`, `test_command`, `test_exit_code`, `test_output_path`, and a recomputable `reproducibility_hash`.
- The validation report enumerates every claim ID alongside its REQ.

### NFR-3 — Security
- No code is executed from the working tree other than `tsc`, the `claim-validator` (via `npx tsx`), and explicit user-authorized git operations.
- No outbound network calls are made beyond `npx` package resolution.

### NFR-4 — Surgical scope
- Every file change in this session traces to a REQ in this spec.
- Defects discovered outside this spec are recorded in the Phase 1 polish backlog in the validation report and are not edited in this session.

---

## Threat model

Validation is a low-attack-surface activity (read-only inspection plus two scoped repair commits). No standalone STRIDE+ASI artifact is required for this spec. Phase 2 work will produce per-area threat models per `templates/threat-model/STRIDE_ASI_TEMPLATE.md`.

---

## Decisions

- **Author this spec rather than skip claims or use a non-`specs/` ref.** `claim-schema.yml` requires `spec_ref` to match `^specs/.+\.md` and `claim-validator.ts` enforces it; P8 (Spec-Anchored Implementation) mandates authoring one when none exists. Approved by the user on 2026-05-22 before any claim was emitted.
- **Run `claim-validator.ts` via `npx tsx`.** No compiled `.js` exists, and there is no `tsconfig.json` or build script. The `.js`/build gap is a Phase 1 polish-backlog item; it does not block Phase 1 validation, but it does break `node verification/claim-validator.js --all` (Prompt 3 step 8) and must be resolved before that step runs.
- **Repair the fifteen-file modified delta via `git config --local core.filemode false`.** Preserves `100755` in the repository's index so contributors retain executable bits on clone; only stops git from surfacing a spurious mode-bit delta locally.
- **Add `.prompts/` to `.gitignore`.** The directory is a local operator scratch area for saved prompt artifacts and is not part of the DevOPs project's committed surface.

---

## Open questions

None blocking. Polish-backlog items are tracked in the validation report and require a deliberate fix commit before `v0.1.0` tagging.

---

## Implementation plan

This spec drives the harness task list T1–T11, executed in the same session. T2–T9 each verify one REQ and emit one proof-of-work claim; T10 produces the report; T11 runs the claim-validator across every emitted claim, writes the baton, and closes out the session.

## Test plan

| REQ   | AC(s)            | Claim ID                |
| ----- | ---------------- | ----------------------- |
| REQ-1 | AC-1.1           | claim-2026-05-22-001    |
| REQ-2 | AC-2.1           | claim-2026-05-22-002    |
| REQ-3 | AC-3.1, AC-3.2   | claim-2026-05-22-003    |
| REQ-4 | AC-4.1           | claim-2026-05-22-004    |
| REQ-5 | AC-5.1           | claim-2026-05-22-005    |
| REQ-6 | AC-6.1           | claim-2026-05-22-006    |
| REQ-7 | AC-7.1           | claim-2026-05-22-007    |
| REQ-8 | AC-8.1, AC-8.2   | claim-2026-05-22-008    |
| REQ-9 | AC-9.1, AC-9.2   | claim-2026-05-22-009    |
| REQ-10| AC-10.1          | claim-2026-05-22-010    |

---

## Change log

- 2026-05-22 miltonadina: created (extracted from Prompt 1 checklist; user-approved spec authoring at validation intake).
