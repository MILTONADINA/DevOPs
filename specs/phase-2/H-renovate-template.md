# Phase 2 / Area H — Renovate Configuration Template

**Spec ID**: phase-2/H-renovate-template
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

`docs/COST_OPTIMIZATION.md` recommends Renovate over Dependabot for dependency upgrades (gap #48 in `GAP_61_COVERAGE_MATRIX.md`). Phase 1 documented the recommendation; Phase 2 area H ships a ready-to-use `templates/renovate/renovate.json` that consumer projects can drop into their repo root to get sensible defaults — grouped patch updates, weekly cadence to reduce PR churn, separate high-priority lane for security-only updates, and explicit support for the package managers the analyzer detects.

Renovate is a CI-side tool; this spec is the configuration template only. It does NOT install Renovate (that is a per-consumer-project setup step).

## Out of scope

- Installing Renovate into a target project (handled by the per-project owner via the Mend Renovate GitHub App or self-hosted runner).
- Replacing GitHub's native Dependabot configuration in *this* repository — already enabled in `prompt-2-github-push` hygiene step. This spec ships a *template for consumer projects* to use.
- Auto-merge policy — the template ships conservative defaults (manual merge); auto-merge is a per-project decision documented but not enabled.
- Multi-repo Renovate orchestration (group-level configs) — deferred.

## Actors and data

- **Primary actors**: consumer-project maintainers (copy the template), Renovate bot (consumes the config).
- **Data classes touched**: [x] none.
- **Compliance scope**: [x] none directly; the template itself is operational config.

---

## Functional requirements (EARS)

### REQ-H1 (Ubiquitous) — Template file exists
THE SYSTEM SHALL contain a JSON configuration file at `templates/renovate/renovate.json` that is valid JSON and parseable by `JSON.parse`.

### REQ-H2 (Ubiquitous) — Extends Renovate's standard preset
THE SYSTEM SHALL ensure the template's `extends` field includes `config:recommended` (Renovate's standard preset) as the base, so consumer projects inherit safe defaults without copying boilerplate.

### REQ-H3 (Ubiquitous) — Weekly schedule by default
THE SYSTEM SHALL ensure the template sets a default schedule limiting routine PR creation to one weekly window (e.g., `before 9am on Monday`) to reduce PR noise.

### REQ-H4 (Ubiquitous) — Security updates lane is independent
THE SYSTEM SHALL ensure the template configures `vulnerabilityAlerts` to bypass the routine schedule — security-critical updates open PRs immediately regardless of the weekly window.

### REQ-H5 (Ubiquitous) — Patch updates grouped
THE SYSTEM SHALL ensure the template groups patch-level updates per package manager (npm patches grouped together, pip patches together, cargo patches together) to reduce PR count.

### REQ-H6 (Ubiquitous) — Supported package managers explicit
THE SYSTEM SHALL ensure the template's `enabledManagers` field (or equivalent) explicitly lists the package managers the analyzer detects: `npm`, `pip_requirements`, `pep621`, `pep723`, `cargo`, `gomod`.

### REQ-H7 (Ubiquitous) — Documentation reference
THE SYSTEM SHALL extend `docs/COST_OPTIMIZATION.md` with a "Renovate setup for consumer projects" section linking to the template path and the Mend Renovate GitHub App install URL.

### REQ-H8 (Event-driven) — Analyzer surfaces the template
WHEN `analyzer/scan.ts` detects a consumer project that lacks a `renovate.json` (or equivalent) AND whose stack indicates an upgrade-relevant package manager, THE SYSTEM SHALL include a `recommended.next_steps` entry pointing at `templates/renovate/renovate.json`.

---

## Acceptance criteria

### AC-H1.1 (maps to REQ-H1)
**Given** the post-implementation repository
**When** `JSON.parse(readFileSync('templates/renovate/renovate.json', 'utf-8'))` is executed
**Then** parsing succeeds and the result is an object.

### AC-H2.1 (maps to REQ-H2)
**Given** the parsed template
**When** the `extends` field is inspected
**Then** the array contains `config:recommended` (exact string match).

### AC-H3.1 (maps to REQ-H3)
**Given** the parsed template
**When** the `schedule` field is inspected
**Then** it contains a Renovate-syntax weekly window (matches the regex `/before \d+(:\d+)?\s*(am|pm) on .+day/i`).

### AC-H4.1 (maps to REQ-H4)
**Given** the parsed template's `vulnerabilityAlerts` block
**When** inspected
**Then** the block has `schedule: ["at any time"]` (or equivalent override) and `labels` including `security`.

### AC-H5.1 (maps to REQ-H5)
**Given** the parsed template's `packageRules`
**When** inspected
**Then** at least one rule matches `updateTypes: ["patch"]` and sets `groupName` so patches batch into a single PR.

### AC-H6.1 (maps to REQ-H6)
**Given** the parsed template's `enabledManagers` (or absence thereof — Renovate's default enables all)
**When** inspected
**Then** if present, the field includes at least `npm`, `pip_requirements`, `cargo`, and `gomod`; if absent, the template includes a top-level comment explaining why all managers are intentionally enabled.

### AC-H7.1 (maps to REQ-H7)
**Given** the post-implementation `docs/COST_OPTIMIZATION.md`
**When** the file is read
**Then** an H2 or H3 section titled `Renovate setup for consumer projects` (or close variant) exists with a link to `templates/renovate/renovate.json`.

### AC-H8.1 (maps to REQ-H8)
**Given** an analyzer fixture project with a `package.json` but no `renovate.json` and no `.github/dependabot.yml`
**When** `node analyzer/scan.ts` runs against it
**Then** the emitted profile's `recommended.next_steps` includes an entry referencing `templates/renovate/renovate.json`.

---

## Non-functional requirements

### NFR-H1 — Performance
- Template loading by Renovate is < 100 ms (trivial for a small JSON file).
- Analyzer detection of "Renovate missing" adds < 50 ms to the scan.

### NFR-H2 — Observability
- Renovate's own logs are the source of truth for upgrade activity once installed; DevOPs does not duplicate that telemetry.

### NFR-H3 — Security
- The template defaults are *conservative*: no auto-merge, no broadening of allowlists.
- The vulnerability-alerts lane (REQ-H4) is the only path that bypasses the weekly schedule, and only for CVEs Renovate's database flags as actionable.

### NFR-H4 — Compliance
- No PII concerns.

### NFR-H5 — Surgical scope
- One new file (`templates/renovate/renovate.json`) and a documented section in `docs/COST_OPTIMIZATION.md`. Optionally an `analyzer/recommendation-rules.yml` extension for REQ-H8.

---

## Threat model

Not a standalone artifact. The template's security posture is bounded by Renovate's well-known threat model (an untrusted dependency upgrade is no more dangerous than the package itself). The conservative defaults (no auto-merge, vulnerability lane separate) keep the agent's blast radius small.

---

## Decisions

- **`config:recommended`, not `config:base`.** Renovate's `config:recommended` preset (introduced 2024) bundles `config:base` plus a set of community-tested defaults. Using it future-proofs against preset renames.
- **Weekly schedule, not daily.** Daily cadence floods small teams with PRs. Weekly with a security-bypass lane is the cost/safety sweet spot. Consumers wanting daily can override.
- **No auto-merge in the template.** Auto-merge requires per-project policy (which lockfile updates are safe? which majors require human review?). Shipping it ON would leak the maintainer's risk tolerance into every consumer project. Off-by-default, document how to enable.

---

## Open questions

None blocking. If Renovate's preset names shift again before implementation, the `extends` value can be updated to the current canonical preset without spec changes (REQ-H2 names the *role*, not a future-stable string).

---

## Implementation plan

Step 3 atomization will likely produce: (1) author `templates/renovate/renovate.json`; (2) update `docs/COST_OPTIMIZATION.md` with the new section; (3) extend `analyzer/recommendation-rules.yml` for REQ-H8; (4) write fixture for AC-H8.1 (a minimal Node project without renovate.json); (5) lint check that validates AC-H1 through AC-H6 in CI.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-H1 | AC-H1.1 | (Phase 2 implementation) |
| REQ-H2 | AC-H2.1 | (Phase 2 implementation) |
| REQ-H3 | AC-H3.1 | (Phase 2 implementation) |
| REQ-H4 | AC-H4.1 | (Phase 2 implementation) |
| REQ-H5 | AC-H5.1 | (Phase 2 implementation) |
| REQ-H6 | AC-H6.1 | (Phase 2 implementation) |
| REQ-H7 | AC-H7.1 | (Phase 2 implementation) |
| REQ-H8 | AC-H8.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-024`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area H; closes GAP_61_COVERAGE_MATRIX gap #48).
