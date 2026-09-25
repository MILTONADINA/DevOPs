# Meta — Prompt-surface accuracy (prompt audit, 2026-09-25)

**Spec ID**: meta/prompt-surface-audit-2026-09-25
**Status**: approved (owner: "i will go with your recommendations", 2026-09-25)
**Last updated**: 2026-09-25
**Owner**: miltonadina

---

## Context

A `/claude-api prompt-audit` of every file that reaches a model as text found 158 verified findings. Most were not model-era prompt tuning. They were instruction text that states facts the code does not bear out: hooks described as wired that are not, model routing stated five different ways, commands and paths that no longer exist. Current Claude models (Claude Opus 5.5 in the main session, Claude Sonnet 5 in the pipeline) take stated environment facts at face value and follow instructions literally, so a false instruction now misleads more reliably than an emphatic one. The full report, one patch per finding, and the verification record are kept locally under `.workflow/state/prompt-audit-2026-09-25/`.

## Out of scope

- Wiring the unwired hooks, registering the plugin manifest's components, per-surface token accounting, and red-first ordering inside the sprint pipeline. Each changes behavior and gets its own spec.
- `stratum/src/billing/pricing.ts`. It is behind the billing four-eyes gate and needs two human approvers.

## Functional requirements (EARS)

### REQ-PSA-1 (Ubiquitous) — Instruction text states only mechanisms that exist
THE SYSTEM SHALL ensure that every instruction file loaded into an agent's context (`CLAUDE.md`, `AGENTS.md`, `constitution/`, `modes/`, `slash-commands/`, `subagents/`, `skills/`, `stratum/.claude/CLAUDE.md`, and the text hooks print) names the script, hook, or check that enforces each rule it calls enforced, and says whether that hook is wired in `.claude/settings.json`.

### REQ-PSA-2 (Ubiquitous) — Model routing matches the code
THE SYSTEM SHALL describe the orchestrator model as the one the owner selects with `/model`, and SHALL describe each pipeline role's model and effort exactly as `.claude/workflows/sprint-cycle.js` passes them.

### REQ-PSA-3 (Event-driven) — The security stage reports every finding
WHEN the sprint pipeline's security stage scans a cycle's changes, THE SYSTEM SHALL have it report every finding with its classification from `subagents/universal/security.md` and a confidence, set `passed` false on any TP-critical finding, and have the validator refuse sign-off on a TP-critical finding.

### REQ-PSA-4 (Ubiquitous) — Start-up reads are scoped to top-level sessions
THE SYSTEM SHALL scope `AGENTS.md`'s mandatory first actions to top-level sessions, while every subagent still loads the client scope (first action 5).

### REQ-PSA-5 (Ubiquitous) — The Claude eval judge uses structured outputs
THE SYSTEM SHALL request the Claude eval judge's JSON reply through the API's structured-outputs feature, keeping the prompt's description of the reply shape for adapters without that feature.

### REQ-PSA-6 (Ubiquitous) — The CI security review uses the latest Opus
THE SYSTEM SHALL pin the `claude-security-review.yml` model override to the latest Opus model (`claude-opus-5-5`), the intent ADR-014 states.

### REQ-PSA-7 (Unwanted behaviour) — Signed skills stay verifiable
IF a change edits a signed `skills/universal/**/SKILL.md`, THEN THE SYSTEM SHALL re-sign it through `release-sign.yml` and refresh its `governance/skill-manifest.yml` pin before the change merges.

## Acceptance criteria

### AC-PSA-1.1 (REQ-PSA-1..6)
**Given** the change applied at its commit **When** `bash -n` runs on each edited hook, `sprint-cycle.js` is parsed as the Workflow runtime parses it, the edited JSON and YAML files are parsed, `npm test` runs at the root, and Stratum's typecheck and the eval tests that import the edited files run **Then** each result equals HEAD's before the change or better.

### AC-PSA-7.1 (REQ-PSA-7)
**Given** the re-signed commit **When** `npm run validate:claims` runs **Then** claims 076 and 078 validate.
