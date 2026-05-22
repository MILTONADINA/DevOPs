# Changelog

All notable changes to DevOPs are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — Phase 1 in progress

### Added
- Initial repository scaffold with full directory architecture
- Constitution layer:
  - `PRINCIPLES.md` — eight principles (Karpathy 4 + DevOPs 4 extensions), each with tradeoff disclosure and observable working signal
  - `ANTIPATTERNS.md` — explicit don'ts with worked examples
  - `LOOP.md` — goal-driven iteration protocol
- Universal hook system with deterministic safety floor:
  - Pre-tool: secret block, prod-write block, `rm -rf` block, **budget brake** (hard USD cap with reserve-commit), **loop detection** (same-call-N-times), client boundary
  - Post-tool: auto-format, gitleaks scan, type check
  - Session-start: load baton, load constitution, verify project profile
  - Session-end: write baton, generate summary, log events
- Ten universal process skills (SKILL.md format):
  - spec-extraction (EARS notation)
  - plan-decomposition
  - baton-handoff (multi-tool session failover)
  - proof-of-work (claim verification)
  - session-summary
  - ask-dont-assume
  - multi-tool-failover (Claude Code → Codex → local LLM rotation)
  - karpathy-guidelines (vendored, MIT, attribution preserved)
  - goal-loop
  - surgical-edits
- Project analyzer:
  - Stack/domain/state/risk detection
  - Recommendation engine for Tier 3 per-project components
  - Installer
- Claim validator (TypeScript) — re-runs proofs, validates exit codes, computes reproducibility hashes
- Memory layer (three backends ready):
  - File-based memory at `memory/file-based/` (working today)
  - Stratum integration via `memory/stratum/` (uses Phase 0 capture proxy + Supabase fact tables)
  - Zep MCP integration via `memory/zep/` (self-hosted Docker compose)
- `AGENTS.md` root contract template
- `CLAUDE.md` Claude Code adapter (sources AGENTS.md)
- `.claude-plugin/plugin.json` — installable as a Claude Code plugin
- `.claude-plugin/marketplace.json` — marketplace metadata
- Mode scaffolding: greenfield, brownfield, migration, hotfix, refactor, debug-prod, audit
- Lifecycle phase scaffolding: discovery, design, build, harden, launch, operate, evolve
- Templates: ADR, EARS spec, threat model (STRIDE + OWASP ASI 2026), runbook, postmortem, SLO spec, status report
- Cost controls: model routing config, budget brakes, loop detection, batch routing
- Observability: OpenTelemetry config, Langfuse setup, Laminar setup, PII redaction
- `GAP_61_COVERAGE_MATRIX.md` — explicit map of where each of 61 identified design gaps is addressed
- Install script (cross-tool)

### Technical decisions
- Universal SKILL.md and AGENTS.md formats over tool-specific configs
- Karpathy guidelines (multica-ai, MIT) vendored rather than re-authored
- EARS notation as the default spec format
- Stratum schema adopted as the structured fact store from day one
- Three-tier model routing (Haiku/Sonnet/Opus) configured by default
- OpenTelemetry baggage for per-tenant cost attribution
- OWASP ASI 2026 baked into threat model templates

---

## Format reference

When adding entries to a new version, use these categories:

- **Added** — new features or capabilities
- **Changed** — changes to existing functionality
- **Deprecated** — features that will be removed in a future version
- **Removed** — features removed in this version
- **Fixed** — bug fixes
- **Security** — security-related changes (always document)
- **Performance** — measurable performance improvements with numbers
