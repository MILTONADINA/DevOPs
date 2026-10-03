# Changelog

All notable changes to DevOPs are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — Later phases in progress

Phase 3 (Memory & observability — Stratum closeout, Option B: Stratum
Phase 0 + 1 + 3 locked per session 7.5 audit) is underway on
`main`. Stratum has grown from the Phase 0 capture-proxy
scaffold described below into a subsystem of this same project (Fastify
proxy, multi-provider gateway, 3-tier memory on the Supabase API, run
against a local Supabase-compatible stack) — one project, not a separate
product. See `docs/LAUNCH_READINESS.md` for current, frequently-updated
status — this file intentionally does not duplicate that detail while the
phase is open.

### Changed — unsigned usage and payment module retirement (specs/ops/payment-removal.md, C2/C3)

- **Breaking:** M1 removes usage signatures, fee columns and mutation guards.
  Upgrade the unsigned writer and schema together; preserve the durable outbox
  during restart. Team usage needs no billing signing secret. Token counts,
  pinned prices and estimated USD differences remain.
- Legacy backups strip and report retired usage columns. Invoice tables still
  export and restore until the coordinated C4 migration.
- **Breaking:** removed the legacy payment library, invoice CLI, billing/Stripe
  verification commands, CLI-only read factory and payment types. Usage reads,
  generic outbound webhook signing, provider routing and PruningLog remain.
- Retired payment and duplicate old-module tests after preserving nonpayment
  coverage, including negative usage deltas and aggregation before rounding.
  C4's invoice schema and actual session-erasure work remain open.

### Changed — payment HTTP surface removal (specs/ops/payment-removal.md, C1)

- **Breaking:** removed the CFO page (`/billing`), invoice, invoice-list and
  audit CSV HTTP routes, and `POST /stripe/webhook`. The proxy no longer uses
  `STRIPE_WEBHOOK_SECRET`; OpenAPI omits the removed payment routes and schema.
- Kept `/v1/billing/summary` and `/v1/billing/records` as usage reads. They
  report token counts and estimated USD savings without fee or signature
  fields, and still refuse project-bound keys with 403. Session stats retain
  token counts and estimated USD savings without `feeUsd`.
- Plan lookup for request limits and token budgets now uses the sessions
  dependencies; the plan limits and starter fallback remain in place.
- Removed `invoice.ready` and `tee.attestation_failed` webhook types and
  the fee field from the `session.ended` sample.
- Signed ledger writes and their signing secret remain until C2. The invoice
  CLI, Stripe library and payment modules remain until C3; invoice tables
  remain until C4. C1 does not remove those components.

### Security — local network hardening (specs/security/stratum-local-network.md)

- **Breaking:** the bind-host setting is now `DEVOPS_PROXY_HOST`. `HOST` is
  deprecated — honored for one release only as an alias, used when
  `DEVOPS_PROXY_HOST` is unset or blank (`DEVOPS_PROXY_HOST` wins when both
  are set) — and logs a deprecation warning when it is set to a non-empty
  value. If your shell or CI exports `HOST` (some set it to the machine's
  name), a personal-mode proxy now refuses to start on that address: unset
  `HOST`, or set `DEVOPS_PROXY_HOST=127.0.0.1`.
- **Breaking:** in personal mode (no auth configured) the proxy answers a
  CORS preflight with `403`, never sends `Access-Control-Allow-Origin`, and
  refuses with `403` any request whose `Host` header is missing or isn't a
  loopback name: `127.0.0.1`, `localhost`, `[::1]`, or a loopback
  `DEVOPS_PROXY_HOST`, with no port or with the proxy's own listening port.
  Any other port gets `403`, so a port forward such as `localhost:5000` to a
  proxy listening on `4080` is refused. A browser app that called the proxy
  from another origin stops working.
- **Breaking:** in commercial mode (auth configured) the proxy sends
  `Access-Control-Allow-Origin` only for the origins listed in
  `DEVOPS_PROXY_CORS_ORIGINS`, which is empty by default; an entry `*` allows
  any origin. `DEVOPS_PROXY_ALLOWED_HOSTS` optionally limits which `Host`
  names it accepts; with it unset any `Host` is accepted.
- A request that carries more than one `Host` header gets `400`
  (`invalid_host`), in every mode.
- **Breaking:** with no auth configured, a non-loopback `DEVOPS_PROXY_HOST`
  (for example a bind-all address) refuses to start unless
  `DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1` is set, in which case the
  proxy starts and logs a warning. Loopback means `localhost`, an address in
  `127.0.0.0/8`, or `::1` (also written `[::1]`). The opt-in only allows the
  bind: with no auth every non-loopback `Host` still gets `403`, so it does
  not make the proxy reachable by its address. Reaching the proxy from
  another device takes auth (`CQ_COMMERCIAL` with Supabase credentials).
- **Breaking:** an invalid `PORT` (not an integer from 1 to 65535) or
  `RATE_LIMIT_MAX` (not a positive integer) refuses to start, and the message
  names the variable and the value it rejected.
- **Breaking:** a provider base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
  `OPENROUTER_BASE_URL`, `GEMINI_BASE_URL` or `CQ_LOCAL_BASE_URL`) that uses
  plain `http` to a non-loopback host refuses to start unless
  `DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1` is set. A model server on another
  LAN host over plain `http` needs that opt-in; loopback `http` (a local
  Ollama or LM Studio server) and `https` are not affected by this rule.
- **Breaking:** a base URL that names the proxy's own listen address (a
  self-loop) refuses to start, and no setting overrides that.
- **Breaking:** the Docker image is removed: `runtime/Dockerfile` and
  `runtime/Dockerfile.dockerignore` are deleted. Run the proxy directly
  (`npm run dev` in `runtime/`); Docker Compose remains for the local
  database stack (`npm run db:start`) and does not host the proxy.
- Nothing changes for a command-line or SDK client on the same machine that
  connects to `localhost` or `127.0.0.1` on the proxy's own port.

### Added — repository hygiene check (quality plan QW-9)

- `scripts/check-repo-hygiene.mjs` runs in CI's `validate` job (`specs/ops/repo-hygiene.md`). It checks four things: every tracked file that starts with `#!` is executable, the plugin and version manifests carry the package version, no render or screenshot is committed outside an allowlist, and the root tests run by glob.
- 22 scripts with a shebang are now executable in git. `.claude-plugin/plugin.json` and `governance/VERSION.md` now say 0.3.0, the released version. The root `npm test` runs `tests/**/*.test.mjs`, so a new test file runs without editing a list.
- The empty `runtime/tests/` stubs are removed. Two stale acceptance criteria in the Phase 0 capture plan are corrected: its fixtures live in `runtime/test/fixtures/anthropic/`, and it never committed `.sse` files.

### Added — runtime lint gate in CI (quality plan QW-1)

- The required `runtime-test` job now runs `npm run lint` in `runtime/`. The script is `eslint src --ext .ts --max-warnings 0 && prettier --check src`, so an ESLint warning or an unformatted file fails the job (`specs/ops/ci-product-suites.md` REQ-3). Four files that Prettier flagged were reformatted; the layout changed, the code did not.

### Changed — `stratum/` is now `runtime/` (owner decision 2026-09-26)

- The runtime (proxy, memory, pruner) moved from `stratum/` to `runtime/`, and its package is `@miltonadina/devops-runtime` (ADR-0026; `specs/ops/one-platform-naming.md` REQ-5). **Breaking** for scripts that use the old path: use `cd runtime` and `npm --prefix runtime`.
- CI's required check `stratum-test` is now `runtime-test`, the test-floor key `stratum` is `runtime` (a declared rename, never a lowering), and the preflight check `deps.stratum` is `deps.runtime`.
- Unchanged: the local database's compose, container and volume names (`devops-stratum-*`) and the settings (`CQ_*`, `STRATUM_*`); a later naming cycle renames the settings.

### Changed — open source, no payment, local-first (owner decision 2026-09-26)

Recorded in `runtime/docs/decisions/0025-open-source-local-first-no-payment.md`.

- The roadmap no longer ends in a commercial product. `plan.md` §9 and
  `blueprint.md` redefine v1.0 as: a user points their AI agent at this
  repository and gets a working local setup on macOS, Linux and WSL2.
  `plan.md` §8 redefines v0.9 as payment removal plus self-hosted team
  features (organizations, API keys, usage estimates, session erasure).
- v0.7 (ZK-Context + AWS Nitro TEE) is dropped: the project hosts no server
  for an enclave to protect. Its Claude Code Security release-gate scan moves
  to v0.8.
- Release gates that waited for a deployment topology are measured on the
  user's machine instead. No gate changed its pass/fail state.
- The hour totals in `plan.md` §11, `blueprint.md` §5 and
  `docs/LAUNCH_READINESS.md` are withdrawn rather than recomputed.
- Token and USD figures stay, as information only. There is no fee and no
  invoice.
- New spec `specs/ops/payment-removal.md` holds the requirements for the
  graph cycles that will remove the payment code. That code (Stripe,
  invoices, the fee calculator, the signed ledger, the CFO page) is still in
  the tree until those cycles land.
- Positioning and pricing copy is rewritten in `README.md`,
  `stratum/README.md`, `stratum/landing.html` and the Stratum business and
  roadmap docs. The Stratum business documents are deleted:
  `stratum/docs/BUSINESS_MODEL.md`,
  `stratum/docs/INFRASTRUCTURE_AND_COST_PLAN.{md,html,pdf}`,
  `stratum/docs/PITCH.md` and `stratum/docs/DESIGN_PARTNER.md`, plus three hosted-era QA screenshots
  in `stratum/.workflow/` (including the CFO billing dashboard and the API docs page).

### Changed — open-source readiness, docs only (2026-09-26)

- Added a root `CODE_OF_CONDUCT.md` (moved from `stratum/`; contact through
  GitHub issues, or GitHub private vulnerability reporting for sensitive
  reports) and a root `.github/pull_request_template.md`.
- `docs/SECURITY.md` now names GitHub private vulnerability reporting as the
  reporting channel. The repository owner still has to enable that setting.
- README Quick start: the install script path is `./scripts/install.sh`, and
  the prerequisites are listed.
- Stratum docs: the URLs of a hosted proxy that does not exist and the unverified
  project email addresses are replaced by `http://localhost:4080` or GitHub
  links;
  `.env.example` uses the local database default and comments out unused
  hosted services; "proprietary" and "customer" wording is reworded.

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
