# Changelog

All notable changes to DevOPs are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — Later phases in progress

Phase 3 (Memory & observability — Stratum closeout, Option B: Stratum
Phase 0 + 1 + 3 locked per session 7.5 audit) is underway on
`main`. Stratum has grown from the Phase 0 capture-proxy
scaffold described below into a live, deployed subsystem of this same
project (Fastify proxy, multi-provider gateway, Supabase-backed 3-tier
memory, CFO dashboard) — one project, not a separate product. See
`docs/LAUNCH_READINESS.md` for current, frequently-updated status — this
file intentionally does not duplicate that detail while the phase is open.

### Removed — redundancy audit (2026-09-14)

A deliberate audit asked, per component: "does a good solution already
exist elsewhere?" — and removed what did, rather than maintaining a
reinvention. Full investigation trail and reasoning in-session; summary:

- **Zep memory backend** (`memory/zep/`, `mcp-configs/universal/memory-zep.json`)
  — zero real call sites anywhere in the codebase; Stratum's own
  `docs/decisions/0004-no-llm-summarization.md` argues its NL-summarization/
  graph approach is inferior to the structured-facts approach already
  chosen. Semantic-temporal recall ("what did anyone ever say about X?") is
  now unsupported — reopen if that need is confirmed.
- **`ask-dont-assume`, `karpathy-guidelines`, `surgical-edits` process
  skills** — all three duplicated Claude Code's own native behavior
  (clarifying-question defaults, `AskUserQuestion`, "no drive-by
  refactoring"). Where a skill had real enforcement behind it, that
  enforcement lives elsewhere and is unaffected: `verification/claim-validator.ts`
  for surgical-edits' "every line traces" rule; the `write-baton.sh`
  session-end hook for ask-dont-assume's blocker-gating.
- **`researcher` subagent** — duplicated Claude Code's native Explore agent
  type. All permission-denial references (pentest MCP tools, threat-model
  docs) updated to drop it; the `security` subagent's least-privilege
  scoping is unaffected.

**Explicitly NOT removed**, because investigation found real differentiated
function or load-bearing coupling, not just apparent overlap:
- Stratum's multi-provider gateway (billing-accuracy justified against
  LiteLLM, per ADR-0019) and Tier-2 Supabase memory (typed facts +
  trusted-FK + fail-closed, unlike mem0/Letta/Zep) — both live/deployed.
- The `security` subagent — it's the actual least-privilege permission
  boundary for the 4 pentest MCP tools, anchoring the sealed Phase 2 ASI02
  security control; cutting it would regress a sealed control, not clean up
  redundancy.
- The `reviewer` subagent — has a real spec-anchoring function distinct from
  its generic-review overlap with installed plugins.
- Stratum's `/dashboard` waste-viewer — confirmed redundant with Langfuse/
  Helicone, but left in place at the user's request since it's a route
  registered in the live production deployment; not touched this pass.

See `README.md`'s new "What's actually differentiated" section for the
resulting honest positioning.

---

## [0.3.0] — 2026-09-23

This release includes Phase 0 observation and Phase 1 measurement work, plus
the graph sprint dashboard and cycle-resume controls.

### Added

- Session capture and a measured waste taxonomy from real Claude Code traffic.
- Fastify measurement proxy with Anthropic forwarding, streaming, exact token
  counts, PII redaction, and a live cost and waste dashboard.
- Graph sprint dashboard, environment preflight, classified fault records,
  and mechanical `/sprint --resume` recovery.
- Claude Code security review integration and per-PR review guidance.

### Security and reliability

- Published repository visibility is now the owner-approved setting; the
  Phase 1 ship requirement and proof check were updated accordingly.
- CI validates claims, dashboard tests, Gitleaks, Semgrep, and the DeepTeam
  gate. DeepTeam visibly skips when no model-provider key is configured.
- Graph preflight tests now supply their own security-tool fixtures on CI.
- Stratum dependency updates clear the npm audit findings present in the
  prior lockfile; 825 unit tests and typecheck passed with the new versions.
- Claude semantic review reports a visible skip while the repository has no
  `CLAUDE_API_KEY`; no Claude review is claimed for this release.

### Remaining gates

- KadaneDial pruning remains out of the request path until the published
  Tier-A evaluation and real-use quality gates pass.
- Memory and audit features already in the tree retain their later-version
  acceptance gates; the v0.3.0 tag does not declare them production ready.

---

## [0.2.0] — 2026-05-25 — Phase 2: Security depth

Sealed on `phase-2-security-depth` (2026-05-24, session 8); full detail in
`governance/changelog/PHASE-2-CLOSURE.md`. 90/90 Phase 2 claims valid.

### Added
- Pentest stack integration (Shannon, PentAGI, Lyrie, pentest-ai)
- DeepTeam OWASP ASI 2026 red-team CI gate
- Prompt-injection defense hardening (rebuff + HMAC boundary,
  `observability/external-content-boundary.ts`)
- Stack-specific security skills
- Sigstore signing + signed skill manifest
- Skill provenance verification at install
- Webhook idempotency skill + analyzer detection
- Renovate template + `ci.yml` lint

### Security
- A.11 final-pass sec-review (ASI02 subagent least-privilege, ASI04
  external-content boundary) — both PASS

---

## [0.1.0] — 2026-05-22 — Phase 1: Foundation

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
