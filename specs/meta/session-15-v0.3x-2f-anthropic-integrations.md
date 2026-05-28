# Spec — Session 15 v0.3.x §2f: First-party Anthropic integrations + per-PR review docs

**Type**: Meta (infrastructure + documentation; wires `anthropics/claude-code-security-review` GitHub Action as PR-gating semantic security review)
**Status**: AUTHORED + CLOSED 2026-05-28 (single-session emission per masterpiece blueprint claim-emission discipline)
**Author**: Milton Adina (Session 15 goal: "develop the project ... deliver a masterpiece" — best-of-the-best path: bundle §2a closure with §2f Anthropic integrations under same masterpiece bar)
**Branch**: `session-15-2f-claude-security-review` → squash-merged to `main` at commit `9cfcc75` (PR #18)
**Quality bar**: production-grade per blueprint §6 — SHA-pinned action references, minimum-required GitHub Actions permissions, explicit model selection (Opus 4.7), documented bootstrap secret requirement (`CLAUDE_API_KEY`), prompt-injection caveat surfaced + version-bounded mitigation plan.

This spec covers the three §2f first-party Anthropic integration tasks per `plan.md §2f` as a coordinated change unit. Single spec + single claim per the masterpiece claim-emission discipline.

---

## REQ-S15-2f-1 — Claude Code Security Review GitHub Action wired on every PR to main

THE SYSTEM SHALL gate every pull request targeting the `main` branch with an AI-powered semantic security review using the `anthropics/claude-code-security-review` GitHub Action, SHA-pinned per AST08, with explicit model selection and minimum-required permissions.

### AC-S15-2f-1.1

WHEN a pull request is opened or updated against `main`, THE SYSTEM SHALL trigger `.github/workflows/claude-security-review.yml` to run the `anthropics/claude-code-security-review` action against the PR diff.

### AC-S15-2f-1.2

THE workflow SHALL SHA-pin the `anthropics/claude-code-security-review` action to a specific commit SHA (not `@main` floating reference). The pin SHA SHALL be documented inline with a comment naming the upstream date or release tag.

### AC-S15-2f-1.3

THE workflow SHALL explicitly set `claude-model: claude-opus-4-7` to override the upstream action's default (currently `claude-opus-4-1-20250805`).

### AC-S15-2f-1.4

THE workflow SHALL request the minimum permissions necessary: `contents: read` + `pull-requests: write`. NO `issues: write`, `actions: write`, or other elevated scopes.

### AC-S15-2f-1.5

THE workflow SHALL skip draft PRs via `if: ${{ github.event.pull_request.draft == false }}` to avoid burning analysis cost on incomplete work.

### AC-S15-2f-1.6

THE workflow SHALL exclude non-source directories from analysis via the `exclude-directories` input: at minimum `node_modules`, `dist`, `build`, `coverage`, `.workflow`, `.remember`, `stratum/data`, `stratum/coverage`.

### AC-S15-2f-1.7

THE workflow SHALL pin `actions/checkout` to the same SHA-pinned reference used by other repository workflows (consistency with PB-12/PB-14 SHA-pinning convention).

### AC-S15-2f-1.8

The decision SHALL be anchored in an Architecture Decision Record at `governance/decisions/ADR-014-claude-security-review-integration.md`, covering: context (semantic vs pattern-matching layering), specific configuration choices with rationale, required `CLAUDE_API_KEY` secret + bootstrap path, prompt-injection caveat + version-bounded mitigation, ≥4 alternatives considered, ≥4 forward-looking re-verification triggers.

---

## REQ-S15-2f-2 — `/code-review` documented in per-PR review checklist

THE SYSTEM SHALL document the Anthropic Claude Code `/code-review` and `/security-review` slash commands as part of the per-PR review checklist in `CONTRIBUTING.md`, alongside DevOPs commands and CI-gated workflows, so PR authors and reviewers see a single coherent review surface.

### AC-S15-2f-2.1

`CONTRIBUTING.md` SHALL contain a "Per-PR review checklist (author + reviewer)" section with three subsections: Author pre-flight, CI-gated, Reviewer confirmation.

### AC-S15-2f-2.2

The Author pre-flight subsection SHALL reference (at minimum) `/code-review`, `/security-review`, `npm run validate:claims -- --all`, lint + typecheck, and the vitest test suite per the Q8.1 binding.

### AC-S15-2f-2.3

The CI-gated subsection SHALL enumerate (at minimum) `ci.yml`, `security-scan.yml`, and `claude-security-review.yml`, with a one-line description of what each gates and the merge-block semantics.

### AC-S15-2f-2.4

The Reviewer confirmation subsection SHALL list ≥4 confirmation items (CI status, spec/ADR reference, threat-model lint, claim emission match) as a checkbox list.

### AC-S15-2f-2.5

The squash-merge convention SHALL be documented with the canonical command (`gh pr merge <N> --squash --delete-branch`) and a reference to the PB-17 Option β branch-protection binding (`required_linear_history=true`).

---

## REQ-S15-2f-3 — Slash command surface check + coexistence convention

THE SYSTEM SHALL verify that DevOPs slash commands do not name-collide with Anthropic Claude Code built-in slash commands, document the resulting coexistence inventory in `slash-commands/README.md`, and establish a forward-looking convention for handling future collisions.

### AC-S15-2f-3.1

`slash-commands/README.md` SHALL contain a complete DevOPs slash command inventory: at minimum `/checkpoint`, `/resume`, `/security-scan`, `/verify-claims`, `/session-summary`, `/threat-model`, `/ears-spec`, `/analyze`, `/launch-readiness`, `/borrow-idea`, `/emit-claim`.

### AC-S15-2f-3.2

`slash-commands/README.md` SHALL contain a "Coexistence with Anthropic Claude Code built-in slash commands" section documenting the relationship between DevOPs commands and Anthropic built-ins (`/code-review`, `/security-review`).

### AC-S15-2f-3.3

The coexistence section SHALL explicitly state that `/security-scan` (DevOPs, pattern matching) and `/security-review` (Anthropic, AI semantic) are COMPLEMENTARY — not a collision — with the layered-defense rationale documented.

### AC-S15-2f-3.4

The README SHALL document a forward-looking convention for handling any future Anthropic slash command that DOES collide with a DevOPs name: rename the DevOPs command, update `.claude-plugin/plugin.json`, add a CHANGELOG entry, and preserve a backwards-compatible alias for one minor version.

### AC-S15-2f-3.5

The README SHALL identify a re-verification trigger: re-run this surface check at every new Claude Code release that ships new slash commands.

---

## REQ-S15-2f-4 — All work landed on main via PR-flow + closure claim emission

THE SYSTEM SHALL land all §2f deliverables on `main` via a single squash-merged PR (PB-17 Option β), with a §2f closure claim emitted under the canonical claim-validator discipline.

### AC-S15-2f-4.1

All §2f files SHALL be on `main` as of the closure SHA: `.github/workflows/claude-security-review.yml`, `governance/decisions/ADR-014-claude-security-review-integration.md`, `CONTRIBUTING.md` (modified), `slash-commands/README.md` (modified).

### AC-S15-2f-4.2

A §2f closure claim SHALL be emitted to `.workflow/proofs/claim-2026-05-22-097.yml` with `spec_ref: specs/meta/session-15-v0.3x-2f-anthropic-integrations.md`, an authored check script at `.workflow/proofs/_checks/req-session-15-2f-anthropic-integrations.js`, and a captured test log at `.workflow/proofs/claim-2026-05-22-097-test.log`.

### AC-S15-2f-4.3

The claim's `git_sha` SHALL reference the squash-merge SHA on `main` (NOT a feature-branch SHA), per claim-validator convention.

### AC-S15-2f-4.4

After §2f claim emission, the validator SHALL report `95/96 valid` claims (1 fail = PB-21 PB-13-coupled exception unchanged from Session 15 §2a baseline).

---

## Cross-references

- `plan.md §2f` — execution checklist for first-party Anthropic integrations
- `blueprint.md §10` — external integrations registry + ADR convention
- `blueprint.md §6` — production-grade quality bar
- `governance/decisions/ADR-014-claude-security-review-integration.md` — the decision record this spec anchors
- `.github/workflows/claude-security-review.yml` — the workflow this spec gates
- `CONTRIBUTING.md` § "Per-PR review checklist (author + reviewer)" — the docs surface this spec defines
- `slash-commands/README.md` § "Coexistence with Anthropic Claude Code built-in slash commands" — the surface-check outcome
- `.workflow/state/polish-backlog.md` PB-12, PB-14 — the SHA-pinning convention this spec inherits
- `.workflow/state/polish-backlog.md` PB-17 — the squash-merge + branch-protection binding this spec respects
- `specs/meta/session-15-v0.3x-2a-code-gaps.md` — sibling Session 15 spec (code-side closure; this spec covers infrastructure-side closure)

## Methodology note

This spec is the post-implementation companion to the §2f code that landed in PR #18 (squash-merge SHA `9cfcc75`). Authored AFTER implementation rather than before — a deviation from canonical spec-first discipline, justified by:

1. §2f was a small (~3.5h estimate) infrastructure addition with no novel design surface (the action and its inputs are upstream-defined; the only DevOPs choices are SHA pin + model override + permissions + excludes).
2. The implementation followed `plan.md §2f` line-by-line, which itself was authored Session 14 as the strategic plan. plan.md §2f served the spec function for guiding implementation.
3. This meta-spec exists to anchor the §2f closure CLAIM — claim-validator requires `spec_ref.startsWith("specs/")`. Plans don't satisfy that constraint; specs do.

Future §2 sub-area closures SHOULD spec-first when they involve novel design surface. §2f's nature (wiring an upstream action with documented inputs) made post-implementation spec authorship defensible.
