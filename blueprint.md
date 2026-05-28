# DevOPs + Stratum — Masterpiece Blueprint

**Owner**: Milton Adina
**Authored**: 2026-05-28 — recalibrated from initial-draft scope-cut error.
**Status**: BINDING from Session 14 forward.
**Quality bar**: **Best-of-the-best, no compromises, no shortcuts.** Same standard as Session 13's "production-grade" framing. The "personal use" framing means "no Stripe billing yet" — it does NOT mean lower quality, looser tests, or less rigor.
**Distribution model** (drives every design decision):
- **Today (v0.2.x → v0.3.x)**: private repo. Solo dev. Building the foundation.
- **Tomorrow (v0.4.x → v0.9.x)**: shareable with friends. They clone, install, and run their own instance. They contribute via PR. Their data stays theirs.
- **Eventually (v1.0.x+)**: commercial-ready foundation. SaaS-mode or self-hosted-pro options. Stripe layer wires in via existing HMAC-signed billing schema.

The repo is private today because of **market timing**, not because of **quality compromise**. Every line of code, every test, every signed skill, every threat model entry is built as if a paying customer will run it.

---

## 0. Calibration record (transparency)

The first draft of this blueprint cut Phases 4, 5, large parts of Phase 3, and relaxed PR-flow + skill-signing + coverage thresholds — under the wrong assumption that "personal use" meant "cut corners." That was a directional mistake.

Reversed in this draft:
- **Phase 4 (ZK-Context + AWS Nitro TEE)** → **KEEP at full scope.** Trust story for friends running this against NDA-sensitive code. Required before any commercial path.
- **Phase 5 (Git-Attestation Audit Engine)** → **KEEP at full scope.** LLM-extracted facts are inherently unreliable; without the audit engine, Stratum's memory becomes a fact-poisoning vector. Coherence-check is non-optional.
- **Phase 3 (Three-Tier Memory)** → **KEEP at full scope.** Pinecone (cross-project semantic search) and Neo4j (function/commit/decision graph) are both load-bearing as soon as a second user installs this.
- **PR-flow (PB-17 Option β)** → **KEEP binding.** Friends contribute via PR; main audit trail matters; squash-merge linear history stays.
- **Sigstore skill signing (PB-13)** → **KEEP load-bearing.** Cryptographic trust chain is the entire installation-trust story for friends.
- **Production coverage thresholds (statements ≥85% / branches ≥80% / functions ≥90% / lines ≥85%)** → **KEEP binding.**
- **Phase 6 — Stripe integration + invoice generation only** → **DEFER to v1.0.x+.** The schema (`billing_records` table, HMAC signing, append-only enforcement) ships in this version cycle; Stripe + invoice generation wires in when there's a paying customer.

What stays cut: nothing of substance. Just the commercial-transaction layer of Phase 6 (the schema stays).

---

## 1. Purpose

Build a verification-first agent operating system (DevOPs) paired with a token-aware memory + observability proxy (Stratum) that, together, make daily Claude Code use disciplined, cheap, persistent across sessions, and cryptographically auditable. The result is a tool I use every day; that my friends install and use; that becomes a defensible commercial product once feature-complete and battle-tested.

Two pieces, one product:
1. **DevOPs** — Claude Code plugin providing constitution, hooks, skills, subagents, claim-validator (the anti-hallucination floor), and lifecycle/mode scaffolding.
2. **Stratum** — local middleware proxy that intercepts every LLM call to count tokens, redact PII, prune context, persist structured facts, audit those facts against Git history, and (eventually) optionally encrypt context end-to-end into a TEE.

---

## 2. End-state vision (v1.0.x — the goalpost)

A user (me, then a friend, then a paying customer) experiences this:

1. **Install in <5 minutes.** `gh repo clone MILTONADINA/DevOPs && cd DevOPs && npm run setup`. Setup script: installs the Claude Code plugin, brings up Supabase local, configures the Stratum proxy on `localhost:4080`, writes the env-var stub.
2. **One env var to activate.** `export ANTHROPIC_BASE_URL=http://localhost:4080`. Now every Claude Code call flows through Stratum.
3. **Visible savings.** Dashboard at `http://localhost:4080/dashboard` shows real-time: tokens consumed, tokens pruned, $ saved, top waste patterns, fact-extraction count, top facts surfaced this session.
4. **Persistent memory.** Open a Claude Code session in a project I worked on last week. The session-start hook queries Stratum's Tier-2 facts (functions changed, decisions made, policies set) and injects relevant ones into context. No re-explaining "we use vitest, not jest." Cross-project queries via Pinecone surface "this pattern was used in project X."
5. **Auditable.** Every fact in memory has a `commit_hash` and `confidence_score`. The audit engine cross-checks facts against current Git state; CONFLICTs surface in the dashboard with a developer alert. Llama spot-checks 10% of extractions; Opus escalation triggers below 0.85 confidence.
6. **Optionally private.** With `ZK_ENABLED=true`, context is AES-256-GCM encrypted client-side with a session-key derived via HKDF from a master key I control. Decryption happens only inside an AWS Nitro Enclave with attested PCR values. Cloudflare logs, Supabase rows, and OTel spans never contain plaintext context.
7. **Disciplined agent.** The DevOPs Claude Code plugin: writes EARS specs before non-trivial code; runs proof scripts for every claim; surfaces AP-5 anti-patterns honestly; respects the constitution; runs hooks deterministically.
8. **Distributable.** Plugin is published as `.claude-plugin/plugin.json`. Releases are signed with cosign + Sigstore. Skills carry `.sig` + `.bundle` files. Git tags are GPG-signed. CHANGELOG follows Keep-a-Changelog. SemVer is enforced.

That is the goalpost. Nothing below it is acceptable.

---

## 3. Scope — what's in, what's out, what's deferred-by-version

### Locked in v1.0.x scope (best-of-best, no cuts)

| Component | Source-of-truth | Why |
|---|---|---|
| DevOPs Constitution + Hooks + Skills (universal + stack-specific) | Existing in repo | Already shipped in v0.2.0; carry forward |
| Claim-validator + proof-of-work re-runnable checks | `verification/` | Anti-hallucination floor; non-negotiable |
| EARS spec authoring discipline | `templates/ears-spec/` + `slash-commands/universal/ears-spec.md` | Saves session loops; produces clean specs |
| Sigstore skill signing (cosign + Rekor) | `.github/workflows/release-sign.yml` + `governance/skill-manifest.yml` | Trust chain for friend installations |
| GPG/SSH-signed git tags (PB-16 closure) | future | Tag integrity for releases |
| PR-flow + branch protection (PB-17 Option β) | `.workflow/state/session-handoff.md` PR-flow doc | Audit trail; friend contributions via PR |
| Production coverage thresholds (85/80/90/85) | `stratum/vitest.config.ts` | Quality gate; no exceptions for personal-tool framing |
| AP-5 anti-pattern surfacing | Session 13 lessons-in-force | Real failure modes; surface honestly |
| Stratum Phase 0 — Observation | `stratum/docs/ROADMAP.md` Phase 0 | Foundation for all later phases |
| Stratum Phase 1 — Measurement Proxy | Phase 1 | Visible value; cost transparency |
| Stratum Phase 2 — KadaneDial Pruner | Phase 2 + `stratum/docs/ALGORITHM.md` | Cost optimization; the big-win |
| Stratum Phase 3 — Three-Tier Memory (Hot/Warm/Cold) | Phase 3 + `stratum/docs/MEMORY_ARCHITECTURE.md` | Cross-session + cross-project persistence; defining feature |
| Stratum Phase 4 — ZK-Context + AWS Nitro TEE | Phase 4 + `stratum/docs/SECURITY.md` | Trust story for sensitive code |
| Stratum Phase 5 — Git-Attestation Audit Engine | Phase 5 + `stratum/docs/AUDIT_ENGINE.md` | Fact coherence check; required for memory to be trustworthy |
| Phase 6 — Billing schema (HMAC-signed `billing_records`, append-only Postgres trigger, GDPR erasure endpoint) | Phase 6 partial | Forward-compat schema for v1.0.x+ commercial; ships in v0.9.x |

### Deferred to v1.0.x+ (commercial-ready milestone; foundation in place by v0.9.x)

- **Stripe integration** for token-arbitrage billing
- **Invoice generation** + CFO dashboard
- **Per-org pricing tiers** (Starter / Growth / Enterprise)
- **Multi-tenant authentication + RBAC** (org/developer/api_key tables already in Stratum schema; auth flow + middleware ships in v1.0.x)
- **Public marketing/landing surfaces**

These are deferred because there's no customer yet — not because they're low quality. They ship as a coordinated commercial launch in v1.0.x with the same rigor as everything below them.

### Out of scope permanently (or until evidence demands otherwise)

- Multi-LLM-provider abstraction (OpenAI, Gemini, etc.). Claude Code is the only target; SDK is Anthropic-specific. Adding others is a separate product.
- Mobile clients
- Hosted SaaS deployment for non-customers (free tier). Self-host only.

---

## 4. Architecture (full vision)

```
┌────────────────────────────────────────────────────────────────────┐
│  Claude Code TUI / Code Editor                                     │
│  ANTHROPIC_BASE_URL = http://localhost:4080                        │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ HTTP / SSE
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  STRATUM PROXY (Fastify, localhost:4080 or Cloudflare Worker)      │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │
│  │ Phase 0:     │  │ Phase 1:     │  │ Phase 2:   │  │ Phase 4: │ │
│  │ capture      │→ │ count + waste│→ │ KadaneDial │→ │ TEE-gate │ │
│  │ session.ts   │  │ detect       │  │ prune      │  │ encrypt  │ │
│  └──────────────┘  └──────────────┘  └────────────┘  └──────────┘ │
│         ↓                ↓                  ↓               ↓     │
│         PII redaction (always; non-optional)                       │
│                              ↓                                     │
│                       FORWARD to api.anthropic.com                 │
│                              ↑                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Phase 6 schema: HMAC-signed billing_records (append-only)    │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────┬─────────────────────────────┬────────────────────────────┘
          │ writes                       │ writes
          ▼                              ▼
┌────────────────────┐         ┌────────────────────────────────┐
│ Supabase local     │         │ Phase 3 Memory                 │
│ (Postgres):        │         │   Tier 1 (Hot):                │
│  - organizations   │◀───────▶│     Durable Object / in-memory │
│  - developers      │         │     rolling window             │
│  - api_keys        │         │   Tier 2 (Warm):               │
│  - sessions        │         │     Supabase facts table       │
│  - facts           │         │     Llama fact extractor       │
│  - audit_conflicts │         │   Tier 3 (Cold):               │
│  - billing_records │         │     Pinecone (semantic)        │
└────────────────────┘         │     Neo4j (graph)              │
                               └────────────────────────────────┘
                                            ↑
                                            │ Phase 5 audit
                                            │ Git-attestation:
                                            │   - Git indexer
                                            │   - Llama spot-check (10%)
                                            │   - Opus escalation (<0.85)
                                            │   - audit_conflicts alert
                                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  AWS Nitro Enclave (Phase 4 — optional, ZK_ENABLED=true)          │
│  - AES-256-GCM context decryption inside enclave only             │
│  - PCR-attestation verification before any decrypt operation       │
│  - HKDF session-key derivation from operator master key            │
└────────────────────────────────────────────────────────────────────┘
                                            ↑
                                            │ session-start hook
                                            │ reads relevant facts
                                            │ injects into context
                                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  DEVOPS (Claude Code plugin; ~/.claude/plugins/devops/)            │
│  - Constitution (PRINCIPLES / ANTIPATTERNS / LOOP)                 │
│  - Hooks (pre-tool / post-tool / session-start / session-end)      │
│  - Skills (signed via Sigstore; cosign verify on install)          │
│  - Subagents (planner / coder / reviewer / tester / security / …)  │
│  - Claim-validator (re-runnable proof discipline)                  │
└────────────────────────────────────────────────────────────────────┘
```

Two surfaces (Stratum proxy + DevOPs plugin) connected via the `session-start` hook reading from Stratum's Tier-2 facts table. The proxy stays on `localhost` for personal/friend installs; deployable to Cloudflare Workers for hosted SaaS in v1.0.x+.

---

## 5. Version roadmap (incremental ship; each version is a polished, complete release)

Best-of-best at every milestone. Ship each version as a real release: signed git tag, signed skills, CHANGELOG entry, release notes, dashboard demo, friend-installable.

| Version | Theme | Scope additions (cumulative) | Approx. effort (remaining from current state) | Ship gate |
|---|---|---|---:|---|
| **v0.2.0** | Foundation + Stratum subtree integration | Already shipped (sealed `aca4982`) | — | Sealed |
| **v0.3.x** | Phase 0 complete + Phase 1 measurement | Phase 0 corpus (5+ sessions, taxonomy, paper notes); Q4 base-URL wiring; P0-F PII redaction wiring; **Phase 1 full**: Fastify proxy, dashboard, Supabase wiring, exact token counting, waste-detection heuristics, full vitest coverage, integration tests against fixtures, signed release | ~90h | Friend can clone, `npm run setup`, point Claude Code at proxy, see dashboard with real numbers; coverage ≥85%/80%/90%/85% |
| **v0.4.x** | Phase 2 KadaneDial Pruner | ONNX bi-encoder; KadaneDial algorithm; eval harness (Tier A/B/C); pruner wired into proxy; dashboard shows pruned/saved metrics | ~120h | Eval suite passes: Faithfulness >0.90, Answer Relevancy >0.88 on Tier A; ZERO regressions on Tier C golden queries; 1 week real-use confirms no quality degradation |
| **v0.5.x** | Phase 3 Three-Tier Memory | Tier 1 rolling window; Tier 2 Supabase facts + Llama extractor; Tier 3 Pinecone + Neo4j; nightly Tier 2 → Tier 3 promotion; DevOPs session-start hook integration; all five fact-type Zod schemas | ~100h | Fact survives 50-turn gap (Tier B eval); Tier 2 query <50ms p95; Tier 3 Pinecone <150ms p95; Neo4j <80ms; Zod validation gates all writes |
| **v0.6.x** | Phase 5 Git-Attestation Audit | Git indexer (`<5s` for last 100 commits); attestation checker; Llama spot-check (10%); Opus escalation (`<0.85` confidence); `audit_conflicts` table + dashboard alerts; cost monitor (Opus audit costs `<2%` of usage) | ~60h | Inject contradicting fact → CONFLICT detected within 5s; correct fact → CONFIRMED; Opus escalation rate <1% across 1000-fact test |
| **v0.7.x** | Phase 4 ZK-Context + AWS Nitro TEE | Client-side AES-256-GCM + HKDF; Nitro Enclave deployment; PCR attestation; `zk_enabled` per-org toggle; TEE Gateway in proxy; raw plaintext audit (grep Cloudflare logs → zero results); attestation rejection test | ~80h | Modified-PCR enclave rejected; latency impact <15ms; raw context appears nowhere in any log/table; independent security reviewer signoff on `SECURITY.md` |
| **v0.8.x** | Polish + operator-readiness | Onboarding flow (`npm run setup` end-to-end in <5 min); operator dashboards (Grafana / Langfuse); error tracking (Sentry); runbooks (incident response, backup/restore); migration scripts (versioned + reversible); performance benchmarks (p99 latency tracked); telemetry policy + opt-out; License + CONTRIBUTING polish; full ADR set | ~50h | Cold-clone-to-running in <5 min on a fresh laptop; backups + restore tested |
| **v0.9.x** | Phase 6 billing **schema** (no Stripe yet) | HMAC-signed `billing_records` writes; append-only Postgres trigger (UPDATE/DELETE rejected); BillingRecord type + recorder; GDPR erasure endpoint (anonymize while keeping financial record); CFO dashboard skeleton (no real billing data yet) | ~30h | Cannot modify a billing record (Postgres trigger test); GDPR erasure runs <30s on 1-year history; schema ready for Stripe wiring |
| **v1.0.0** | Commercial-ready foundation | Stripe integration; invoice generation; per-org pricing tiers; multi-tenant auth + RBAC middleware; public CHANGELOG; release notes; landing surfaces optional | ~40h | First real invoice sent + paid by a design partner; CFO dashboard shows revenue |

**Total remaining envelope to v1.0.0**: ~570h.

That's roughly 14-18 months of part-time evenings/weekends. Ship every version. Don't accumulate half-done work across versions — that's how masterpieces become tech-debt graveyards.

---

## 6. Quality bar (no exceptions)

These are not negotiable for any version. Every PR is gated.

### Code

- TypeScript strict mode. No `any` types. Per stratum CLAUDE.md.
- Every async function has explicit error handling. No unhandled promise rejections.
- Every exported function has JSDoc with `@param`, `@returns`, `@throws`.
- Rust code uses `thiserror`. No `.unwrap()` in production paths.
- File naming: `kebab-case.ts` files; `PascalCase` classes; `camelCase` functions/variables; `SCREAMING_SNAKE_CASE` constants.

### Testing

- vitest for stratum (Q8.1 binding). Coverage thresholds: statements ≥85%, branches ≥80%, functions ≥90%, lines ≥85% on production code paths.
- Integration tests against real fixtures (not synthetic) wherever Phase 0 corpus or later session data exists.
- Eval suite (Phase 2+): Faithfulness >0.90, Answer Relevancy >0.88 on Tier A datasets (LoCoMo, MT-Bench+, SCM4LLMs); ≥4 Tier B scenarios; ≥30 Tier C golden queries; zero regression tolerance on Tier C.
- Adversarial tests: PII-leak attempts, injection probes (canonical + variants), malformed input, partial response, network drop.
- Per-PR CI: vitest + lint (eslint + prettier) + typecheck + claim-validator + threat-model lint + skill-signing verification.

### Security

- PII redaction wired into every path that touches user data: capture artifact, Supabase rows, OTel spans, dashboard rendering, error logs.
- Sigstore skill signing on every shipped skill; cosign verify-blob in the installer (`analyzer/install.ts`).
- GPG/SSH-signed git tags on every release.
- OWASP ASI 2026 threat model entries for every area (templates exist; populate as features ship).
- Secret-scanning (gitleaks) in pre-commit + CI.
- AES-256-GCM + HKDF for any encryption at rest where applicable (Phase 4).
- AWS Nitro PCR attestation verified BEFORE any decryption (Phase 4).
- No plaintext context outside TEE boundary once Phase 4 ships.
- Threat model lint runs on every PR touching `governance/` or `skills/universal/security/`.
- **Claude Code Security Review integration** (Anthropic first-party): `anthropics/claude-code-security-review` GitHub Action wired on every PR to `main` from v0.3.x forward. Posts inline comments for SQL injection, XSS, auth flaws, insecure data handling, and dependency vulnerabilities. Composes with our existing security stack (does not replace it).
- **Claude Code Security (reasoning-based, Feb 2026)** wired in v0.7.x+ for release-gate scans. Reads code the way a human security researcher would — traces data flow, catches complex vulnerabilities pattern-matchers miss. Particularly valuable around the Phase 4 TEE boundary + Phase 3 fact-extraction paths.
- **Code-review skill integration**: Anthropic's built-in `/code-review` command is part of the PR review flow. Our existing `slash-commands/universal/verify-claims.md` + `slash-commands/universal/security-scan.md` complement it (claim re-runs verify behavior; code-review catches diff bugs).

### Observability

- OTel everywhere. Spans for every proxy request; metrics for token counts, prune ratios, fact extraction; events for session-start/-end + audit conflicts.
- PII redactor wraps every OTel exporter (already exists in `observability/pii-redaction.ts`).
- Grafana / Langfuse dashboards in v0.8.x.
- Sentry for error tracking in v0.8.x.
- Cost monitor: Opus audit costs <2% of revenue (Phase 5 acceptance criterion).

### Documentation

- README — what this is + how to install in <60 seconds of reading.
- PERSONAL_USE.md / OPERATOR_GUIDE.md — daily workflow doc.
- DEVELOPER_GUIDE.md — for friends contributing.
- ARCHITECTURE.md — system design overview.
- SECURITY.md — threat model + crypto details.
- ADRs in `stratum/docs/decisions/` for every load-bearing decision.
- LAUNCH_READINESS.md — honest progress math (effort-hours methodology).
- CHANGELOG.md — Keep-a-Changelog format.
- THREAT_MODEL.md — STRIDE + OWASP ASI 2026 per area.

### Operations

- One-command install (`npm run setup`).
- One-command Stratum bring-up.
- One-command teardown.
- Versioned + reversible Supabase migrations.
- Backup + restore documented + tested.
- Versioned data formats (session JSON has `schema_version`; migration script handles upgrades).
- Health check endpoint on the proxy (`/health`).
- Graceful shutdown (SIGTERM drains in-flight + flushes captures + persists facts).

### Distribution

- Plugin published as `.claude-plugin/plugin.json`.
- Stratum publishable as standalone npm package + container.
- Versioned, signed releases via GitHub Releases.
- SemVer enforced.
- Friend can `gh repo clone` + `npm run setup` → working in <5 minutes.

---

## 7. Asking myself the important questions (with answers)

| Question | Answer |
|---|---|
| What's the highest-risk path? | **Phase 2 KadaneDial Pruner.** Eval thresholds (Faithfulness >0.90, Answer Relevancy >0.88) are unforgiving. If pruning degrades AI quality, the whole pruner has to be tuned or abandoned. **Mitigation**: Phase 2 ships behind a feature flag (`prune_enabled: false` by default); 1 week of design-partner-shadow-mode (compute prune decision but don't apply) before flipping on. |
| What's the most underestimated cost? | **Documentation + onboarding for friends.** "Setup in <5 min" requires hours of polish. v0.8.x exists specifically to address this. Don't skimp. |
| What's the biggest risk to "best of the best"? | **Half-built features across versions.** Stratum has 7 phases; if I jump from Phase 1 to Phase 4 mid-build, I'll have neither done well. **Discipline**: every version 100% done (acceptance criteria met, coverage held, eval passing, threat model entry written, ADR captured) before the next version starts. |
| What's the riskiest direction-change still possible? | **Phase 4 TEE complexity.** AWS Nitro Enclave + PCR attestation is genuinely hard. If it slips, ZK-Context becomes a roadmap risk. **Mitigation**: build Phase 4 LAST (v0.7.x) so the rest of the system is mature; have a fallback "encryption-at-rest only, no TEE" mode that ships if TEE proves unworkable. |
| Phase 2 (pruner) vs Phase 3 (memory) — which first? | **Phase 2 first** (per original Stratum spec order). Reason: pruner produces cleaner sessions → cleaner fact extraction → higher-quality Phase 3 memory. Reversed order leaves Phase 3 extracting facts from noisy data. Also: cost is a higher-urgency pain point than productivity. |
| Phase 5 (audit) vs Phase 4 (TEE) — which first? | **Phase 5 first** (v0.6.x before v0.7.x). Reason: audit engine is required before facts can be trusted; once facts are trustworthy, adding TEE makes sensitive-context use safe. TEE before audit = encrypted lies. |
| Do I need to support non-Anthropic LLMs? | **No.** Out of scope permanently. Claude Code is the only target; adding OpenAI/Gemini is a separate product. |
| What happens if Anthropic changes its API? | The proxy is at the SDK boundary. SDK version pinning + integration tests against canned fixtures + a thin abstraction layer (already in `stratum/src/lib/anthropic.ts` stub) hedge this. |
| What's the killer "wow" feature that gets friends excited? | **Phase 3 cross-session memory.** "Stratum knows what we decided last week" beats "Stratum saved you $5 today" emotionally. But Phase 2 ships first per the spec-author's wisdom (clean data → clean facts). |
| What about the Anthropic SDK version pin `^0.39.0`? | **Verify and bump.** Current SDK has had major changes since 0.39. Add to v0.3.x checklist: confirm capture-session.ts works against latest SDK; bump pin; tests against new fixtures. |
| Should there be a public marketing page? | **No, until v1.0.x.** Private repo + friends-distribution doesn't need marketing. Build the product; the product is the marketing. |
| What about local LLM rotation (Codex / Ollama)? | **Out of scope.** `subagents/universal/researcher.md` mentions multi-tool-failover but that's about agent-orchestration failover, not LLM-provider failover. Defer indefinitely; not part of the masterpiece. |
| What about the streaming-response support (P0-B)? | **Build it in v0.3.x as part of Phase 1.** Claude Code uses streaming in many flows. Treat it as Phase 1 work, not Phase 0 work (the prior re-scope was correct on this). |

---

## 8. What the audit revealed (gaps + corrections)

Identified during the deep dive; flagged for action in plan.md.

### Real gaps in the work-to-date

| Gap | Impact | Where addressed |
|---|---|---|
| Phase 0 content corpus 0% met (1 session JSON, 23 unfilled markers in waste-taxonomy, paper-notes is a stub) | Phase 0 acceptance criteria require 5+ sessions, ≥4 named waste categories, ≥5 paper notes | plan.md §2 |
| Q4 base-URL override not wired (`stratum/scripts/capture-session.ts:144` hardcoded) | Cannot layer Phase 1 proxy over Phase 0 capture | plan.md §1 |
| PII redaction NOT wired into capture-session.ts | Capture artifacts contain raw PII | plan.md §1 (SECURITY-BEARING) |
| Anthropic SDK pinned at `^0.39.0` (likely stale) | Major SDK changes since 0.39; may not work against current API | plan.md §3 |
| No `npm run setup` flow at repo root | Friends can't onboard in <5 min | plan.md §8 (v0.8.x polish) |
| No telemetry policy / opt-out documented | Operators don't know what's emitted | plan.md §8 |
| No backup/restore for `facts` table | Facts are valuable; losing them is bad | plan.md §8 |
| No rate-limit wired on proxy (`@fastify/rate-limit` in deps but unused) | Abuse vector if anyone reaches the proxy | plan.md §3 (Phase 1) |
| No retry/backoff for Anthropic API errors (429, 5xx) | Noisy failures | plan.md §3 (Phase 1) |
| No streaming response handling in capture-session.ts | Claude Code uses streaming heavily | plan.md §3 (Phase 1 includes P0-B work) |
| No multi-environment config (dev/staging/prod) | Friends with different setups will have config friction | plan.md §8 |
| No Cloudflare Worker deployment path | Spec mentions CF Workers; current code is Node-only | plan.md §10 (v1.0.x optional) |
| No conversation export/import format | Sharing a debugged session with a friend has no clean format | plan.md §10 (v0.8.x polish) |
| Error tracking (Sentry) not wired | Production issues invisible | plan.md §8 (v0.8.x) |
| Performance monitoring (latency p99) not tracked | Can't enforce <15ms TEE overhead Phase 4 acceptance criterion | plan.md §8 (v0.8.x) |
| Stratum CLAUDE.md says "you are building infrastructure, not a plugin" — commercial framing | Aligned with this blueprint actually | No change needed |
| Session 13's "production-grade, retire personal-tool framing" pivot in session-handoff.md | **Aligned with this blueprint.** The personal-tool framing was the wrong correction; production-grade IS correct. | No change needed; supersede draft-1 of this blueprint that walked it back |
| PB-13 + PB-16 still open (billing-block + key-generation) | Skill-signing trust chain incomplete until PB-13 closes; tag signing not in place until PB-16 closes | plan.md §1 — user-side actions required |

### What stays bindingly true (carry-forward from Session 13)

- Q1-Q8 + Q8.1 §7 resolutions all binding (Supabase local-only, per-turn live countTokens, indefinite retention + stderr warning, env-var primary base-URL, fastify 5, multi-tenant SHAPE / single-tenant ENFORCEMENT default `tenant_id="personal"`, OTel soft dep, **vitest** as test runner)
- v0.2.0 sealed at `aca4982`. Do not modify.
- Read-all-first-then-Write discipline (saved-memory rule).
- JS regex no PCRE — use `[\s\S]` for multiline.
- `crash-replication.jsonl` stays retired (was based on fictional CHANGELOG entry).
- claim-validator + claim-by-session emission discipline.
- AP-5 pattern surfacing.

---

## 9. Definition of "v1.0.0 shipped"

When I can answer YES to all of these, v1.0.0 ships and the repo can go public if I choose:

- [ ] A friend can `gh repo clone` and have a working Stratum + DevOPs setup in <5 minutes on a clean laptop.
- [ ] The dashboard at `localhost:4080/dashboard` shows live token usage, prune savings, fact-extraction count, top facts surfaced, audit-conflict alerts.
- [ ] When I open Claude Code in a project I worked on last week, prior decisions surface automatically. No re-explaining.
- [ ] PII never appears in any capture artifact, Supabase row, OTel span, or log.
- [ ] vitest test suite GREEN with coverage at 85/80/90/85% production thresholds.
- [ ] Eval suite GREEN: Faithfulness >0.90, Answer Relevancy >0.88 on all Tier A datasets; zero Tier C regressions.
- [ ] All shipped skills are Sigstore-signed; `cosign verify-blob` passes for all.
- [ ] All git tags from v0.3.0+ are GPG-signed.
- [ ] Threat model entries (STRIDE + OWASP ASI 2026) exist for every Phase + every Area.
- [ ] ADRs exist for every load-bearing decision.
- [ ] An independent security reviewer has signed off on SECURITY.md.
- [ ] One real invoice has been sent and paid by a design partner (Phase 6 working).
- [ ] Backup + restore have been tested at least once on real data.
- [ ] If I were hit by a bus tomorrow, a competent dev could read README + blueprint.md + plan.md + ARCHITECTURE.md + PERSONAL_USE.md and resume meaningful work within 1 day.

---

## 10. External integrations + borrowed patterns

We integrate with first-party tools rather than re-implementing them. We borrow patterns from prior-art repos rather than reinventing.

### First-party Anthropic integrations (composed with our stack, not replaced)

| Integration | Ships in | Purpose | Where it fits |
|---|---|---|---|
| `anthropics/claude-code-security-review` GitHub Action | **v0.3.x** | PR-gated pattern-based security scan (SQL injection, XSS, auth flaws, dep vulns). Inline comments. | New workflow `.github/workflows/claude-security-review.yml`. SHA-pinned per AST08. Runs on every PR to main. Composes with our gitleaks + semgrep + threat-model-lint. |
| Claude Code `/code-review` slash command | **v0.3.x onward** | Diff-correctness review per PR | Part of the PR-review flow. Complements our claim-validator re-runs (which prove behavior) — code-review catches diff bugs the validator can't see. |
| Claude Code Security (reasoning-based, Feb 2026 GA) | **v0.7.x** | Data-flow tracing security analysis — reads code "the way a human security researcher would." Catches complex vulns rule-based scanners miss. | Release-gate scan before any v0.x → v0.(x+1) tag. Especially load-bearing around the Phase 4 TEE boundary + Phase 3 fact-extraction paths where data flow is the threat. |
| Claude Code Plugin Marketplace (`/plugin install`) | **v0.8.x → v1.0.x** | Distribution channel | Publish DevOPs via `.claude-plugin/plugin.json` (already exists) once docs + onboarding are polished in v0.8.x. |

### Borrowed patterns (idea-level, not copy-paste; we keep our own implementations)

| Pattern | Source | Where we apply it | Effort estimate |
|---|---|---|---|
| **Subagent-driven-development autonomous loops** | [obra/superpowers](https://github.com/obra/superpowers) | Extend our existing subagents (`subagents/universal/{planner,coder,reviewer,tester,security,validator}.md`) with explicit autonomous-loop semantics: agent works, inspects, reviews, continues — for hours without deviation. Spec → plan → subagent-driven implementation rhythm. Strict TDD red/green + YAGNI + DRY enforcement. | +15h folded into v0.4.x (alongside Phase 2 pruner work) |
| **Interactive knowledge-graph view of the codebase** | [Lum1104/Understand-Anything](https://github.com/Lum1104/Understand-Anything) | New layer on top of Phase 3 memory: project's files/functions/decisions as graph nodes; cross-references as edges. Renders in the existing dashboard (v0.5.x adds a `/dashboard/graph` view). Builds on the Phase 3 facts table (Tier 2 Supabase) + Phase 3 Tier 3 Neo4j (graph already in scope per spec). Adds: visualization layer + fuzzy/semantic search + guided tours auto-generated from dependency order. **Already aligned with Phase 3 architecture — Neo4j was always going to be there; this just exposes it visually + adds the tour-generation logic.** | +30h folded into v0.5.x (Phase 3 memory work) |
| **Universal coding-agent contract** (works with Claude Code, Codex, Cursor, Copilot, Gemini CLI) | Both repos demonstrate this works | Our existing `AGENTS.md` + `CLAUDE.md` already follow this pattern. **Validation, not new work.** Continues binding from v0.3.x forward. | 0h (already binding) |
| **TDD red/green discipline** from superpowers | obra/superpowers | Extend `constitution/PRINCIPLES.md` with explicit red/green TDD as a binding principle (already implied; make it explicit). | 1h doc-only |
| **Karpathy-pattern LLM wiki** support for knowledge bases (not just codebases) | Lum1104/Understand-Anything | `/understand-knowledge` companion command — point at a Karpathy-pattern wiki, get a force-directed knowledge graph. Becomes useful when memory layer matures (v0.5.x+); could complement DevOPs's `memory/file-based/` adjacent. | Defer to post-v1.0.0 unless we hit a real use case |

### Specifically not borrowing

- Understand-Anything's multi-tool plugin format wrappers (.copilot-plugin, .cursor-plugin, etc.) — we ship Claude Code first via `.claude-plugin/`; other tools come later when there's demand.
- Superpowers's pnpm + monorepo structure — we already have a working monorepo-ish layout via stratum/ subtree; no migration needed.

---

## 11. Ideas → Artifacts workflow (how we add things going forward)

This is the iteration loop established Session 14:

1. **You bring ideas**: URLs (other repos, features, papers), feature requests, observations, market signals, problems you hit in daily use.
2. **I research + understand**: read the source repos via `gh`, search current docs, identify what's worth borrowing vs what stays out of scope.
3. **I synthesize**: explicit "we borrow X / we don't borrow Y / because Z" reasoning. Surface tradeoffs.
4. **I revise artifacts**: blueprint.md + plan.md updates (and any other docs as needed — LAUNCH_READINESS.md, baton.md, session-handoff.md, ROADMAPs).
5. **You review + iterate**: push back on any change you disagree with; new ideas spawn another round.

**Discipline rules for this loop**:

- Each iteration produces a clear artifact delta. No "I'll update the plan eventually" — always-now-or-not.
- Adding scope ALWAYS shows the effort estimate impact (e.g., "+30h folded into v0.5.x").
- Cutting scope is OK; explicit "we don't borrow Y because Z" is required.
- We never silently bloat the envelope. Every borrowed idea has a version it ships in.
- For Anthropic first-party tools (`/security-review`, `/code-review`, plugin marketplace): default to **integrate**, not **replace**.
- For prior-art repos: borrow patterns/ideas, not code (license + maintenance reasons). Cite the source in blueprint + relevant ADR.
- If a new integration would push v1.0.0 past 24 months part-time, ask explicitly whether to defer.

### 11.1 Launch readiness reporting — canonical format + discipline

The launch-readiness output is ALWAYS derived from markdown source-of-truth. Never fabricated, never reconstructed from memory.

**Sources (read-in-order)**:

1. `blueprint.md` §3 + §5 — scope + version sequencing
2. `plan.md` §11 — version table + envelope math
3. `docs/LAUNCH_READINESS.md` — current status snapshot + history
4. `.workflow/state/polish-backlog.md` — open/closed PBs
5. `.workflow/state/baton.md` + `.workflow/state/session-handoff.md` — latest session state
6. `git log` / `gh pr list --state merged` — branch + PR reality

**Canonical output**: the table set produced at end of Session 14. Includes:

| Table | What it shows |
|---|---|
| Version roadmap | v0.2.0 → v1.0.0 with status / hours done / hours remaining / progress / ship gate |
| Session-N idea-additions (if any since last refresh) | Borrowed patterns + first-party integrations + effort per version |
| Polish backlog state | Closed (count + list) vs Open (item-level status) |
| Validator state | Total emitted / valid / invalid / rate |
| Branch matrix | Active branches, archival branches, sealed tag |
| PR history | Last N PRs with merge SHA |
| Open carry-forward | Non-blocking items + triggers |
| Pre-flight blockers | What gates the next version's kickoff |
| Headline summary | Where-we-are + what's-next + total envelope math |

**Refresh triggers** (when LR is updated + the table regenerated):

- Every version ship (v0.x.0 tag cut)
- Every PR merge that adds, removes, or re-estimates plan.md tasks
- Every Ideas → Artifacts iteration that adjusts envelope
- On user request ("show me status", "/launch-readiness", "where are we", "give me a report")
- Every session-end (per plan.md §10b recurring tasks; baton.md captures any state delta even if LR not regenerated)

**Anti-fabrication rule** (absolute):

- If a number isn't in the .md sources, the report says "not yet recorded — refresh required" rather than inventing.
- Effort estimates always cite their source line in plan.md.
- Validator counts always cite either `npm run validate:claims -- --all` output or the documented exception (PB-21 coupled to PB-13).
- Polish-backlog status always cites `.workflow/state/polish-backlog.md` (gitignored — local-truth-of-record per Session 9 design).
- Branch matrix always cites `git rev-parse` / `git ls-remote` outputs, not memory.
- PR history always cites `gh pr list` / `gh pr view` outputs, not memory.

**Slash command**: `/launch-readiness` invokes the canonical generator. See `slash-commands/universal/launch-readiness.md`.

---

## 12. Companion docs

- **`plan.md`** — execution checklist (created alongside this blueprint; covers every line of work to v1.0.0)
- **`PERSONAL_USE.md`** — daily workflow guide (to be written in v0.3.x; on plan.md)
- **`DEVELOPER_GUIDE.md`** — contribution + setup guide for friends (to be written in v0.8.x)
- **`ARCHITECTURE.md`** — system design overview (to be written in v0.8.x)
- **`.workflow/state/plans/stratum-phase-0-capture.md`** — full Phase 0 spec (unchanged; this blueprint references its open questions)
- **`docs/LAUNCH_READINESS.md`** — math + status (still authoritative for figures)
- **`stratum/docs/ROADMAP.md`** — upstream Stratum roadmap (still the source-of-truth for phase scope; this blueprint applies version sequencing on top)
- **`governance/changelog/ROADMAP.md`** — DevOPs-side phase roadmap

---

## 13. The standing rule

> Best-of-the-best at every layer, every version, every PR. No exceptions for "it's just personal." It's personal NOW because the market timing is private. It will not be personal forever. Every decision is made as if a paying customer will run it tomorrow.
