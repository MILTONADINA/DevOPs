# Stratum Phase 0 — Capture — Implementation Spec

**Spec ID**: `stratum-phase-0-capture`
**Status**: AUTHORED 2026-05-25 (Session 10 Phase C); awaiting user answers on §7 open questions before Session 11 implementation begins
**Scope**: Build Stratum Phase 0 (session capture + token forensics) from scaffold-state under Option B
**Owner**: miltonadina
**Source of truth for scaffold state**: `.workflow/state/stratum-audit/01-stratum-state.md`
**Mirror pattern**: Phase 2 area-spec format (e.g., `phase-2-C-prompt-injection-hardening.md`) — proved reusable
**Estimated effort**: ~52h total (P0-A through P0-G; see §3)

---

## §1 — Scaffold reality (audit-derived 2026-05-25)

Stratum at HEAD `4665d2e` (post-Session-10-Phase-A bump):

| Metric | Value |
|---|---|
| Substantive LOC | ~516 (248 SQL migration + 247 capture-session.ts + ~10 rust hot-path + 0 actual proxy code) |
| Documentation LOC | ~5,116 across `stratum/docs/` |
| Test coverage | **0 tests** — only `.gitkeep` placeholders under `tests/{api,integration,unit}/` |
| Phases shipped per Stratum's own roadmap | **0 of 7** (checkboxes all unchecked) |
| Known defects per `stratum/CHANGELOG.md` | Streaming-response crash in capture script |
| License | MIT (note: package.json name is "startum" — Stratum/Startum typo persists upstream; out of DevOPs scope) |
| Dependencies post-PB-18 bump | fastify `^5.8.3`, uuid `^11.1.1` (was 4.x/9.x; vulnerable per Dependabot, FIX-PREVENTIVE applied) |
| Installed state | NO lockfile, NO `node_modules/`, never `npm install`'d in this repo |

**What capture-session.ts does today**: Fastify listening on port 4090, intercepts `POST /v1/messages`, calls `client.messages.countTokens()` for exact input-token measurement, forwards to real Anthropic API, captures (request, response, token_counts, elapsed_ms) per turn, writes session JSON to `data/sessions/session-<uuid>.json` (gitignored). Uses `randomUUID()` from `node:crypto` (NOT the `uuid` package — the `uuid` import is dead code).

**Streaming-response crash**: CHANGELOG records that when the Anthropic API returns a streaming response (`stream: true` in request body), the script crashes. Root cause: capture handler assumes a single Response object with full body; doesn't handle Server-Sent-Events stream protocol. This is P0-B's primary deliverable.

Source: `.workflow/state/stratum-audit/01-stratum-state.md` (authoritative; do not improvise contradictions).

---

## §2 — Phase 0 target definition (personal-tool v0.3.x)

"Phase 0 complete" means:

1. **Proxy forwards reliably**: streaming + non-streaming Anthropic API calls round-trip correctly. No crash on stream responses. Connection-loss + partial-response edge cases handled with explicit error paths.

2. **Exact token counting**: every turn records exact `input_tokens` (via `@anthropic-ai/sdk` `messages.countTokens()`) + `output_tokens` (from Anthropic's `usage` field in the response). NO estimates. Per Stratum's own CLAUDE.md: "Token counts must be exact. Estimates are not acceptable."

3. **Session JSON schema versioned**: schema version field on every session JSON. Semver-style (`schema_version: "0.1.0"`). Schema changes go through versioned migration path.

4. **Storage backend wired**: per-session JSON written to Supabase `sessions` table (append-only, RLS-respecting). Reuses migration patterns from DevOPs (RLS conventions, timestamptz defaults, uuid PKs).

5. **PII redaction applied PRE-storage**: every payload passes through `observability/pii-redaction.ts` (DevOPs's existing redactor) BEFORE Supabase write. Stratum does NOT duplicate the redaction logic — consumption only.

6. **Observability events emit**: session-start, session-end, session-error, turn-recorded events emit to DevOPs OTel collector (localhost:4317 grpc or 4318 http) per `observability/otel-config.yml`. Events carry baggage (session_id, tenant_id, schema_version).

7. **Auth passthrough**: proxy reads `ANTHROPIC_API_KEY` from operator's env, forwards in `x-api-key` header to Anthropic. NEVER persists the key to disk, NEVER logs the key, NEVER includes the key in OTel spans or Supabase rows. Key in memory only for proxy lifetime.

8. **Error handling**: explicit catch-paths for: (a) network failure to Anthropic, (b) malformed JSON in response, (c) partial stream truncation, (d) Anthropic auth failure (401), (e) Anthropic rate-limit (429), (f) Supabase write failure (must NOT block forward), (g) PII redactor exception (FAIL-CLOSED: drop the payload, don't proceed to storage).

9. **Test coverage**: unit tests against mocked Anthropic responses + integration tests against a recorded transcript fixture. Coverage threshold: ≥80% of capture-handler branches (excluding generated SDK code).

---

## §3 — REQ decomposition (P0-A through P0-G)

| Sub-area | Scope | Effort (h) | Cross-deps | Branch |
|---|---|---:|---|---|
| **P0-A** | Test harness + mock Anthropic responses (streaming + non-streaming + error paths) | ~12 | none | `stratum-phase-0-capture-test-harness` |
| **P0-B** | Streaming response handling — fix CHANGELOG crash; SSE stream parsing + reassembly | ~8 | P0-A | `stratum-phase-0-capture-streaming` |
| **P0-C** | Token counting reliability hardening (`countTokens` integration; cache for repeated counts; degrade-gracefully on countTokens API failure) | ~6 | P0-A | `stratum-phase-0-capture-token-counting` |
| **P0-D** | Session JSON schema + semver versioning + migration scaffolding | ~4 | none | `stratum-phase-0-capture-schema` |
| **P0-E** | Supabase storage backend wiring (append-only `sessions` write; RLS; reuse DevOPs migration patterns) | ~10 | P0-D + DevOPs schema | `stratum-phase-0-capture-storage` |
| **P0-F** | PII redaction consumption from `observability/pii-redaction.ts` (NOT duplication) | ~6 | P0-E + `observability/pii-redaction.ts` | `stratum-phase-0-capture-pii` |
| **P0-G** | Observability event emission (OTLP-compatible spans; baggage propagation per `observability/otel-config.yml`) | ~6 | P0-F + DevOPs event schema | `stratum-phase-0-capture-otel` |

**Total: ~52h** — within the ~30-80h range tolerance (`.workflow/state/stratum-audit/04-gap-roadmap-deltas.md` Option B Phase 0 envelope assumption). If actual execution diverges >50%, STOP and surface — Option B's full-project denominator (currently 996h, with 619h Phase 3 budget) may need revision.

---

## §4 — Acceptance criteria per REQ

### P0-A — Test harness + mock Anthropic responses

**Deliverable**: `stratum/tests/api/anthropic-mocks.ts` + `stratum/tests/integration/capture-roundtrip.test.ts`

**ACs**:
- AC-P0-A.1 Mock Anthropic non-streaming response fixture exists at `stratum/tests/fixtures/anthropic/non-streaming.json` with realistic shape (id, content, model, role, stop_reason, type, usage)
- AC-P0-A.2 Mock Anthropic streaming response fixture exists at `stratum/tests/fixtures/anthropic/streaming.sse` with realistic SSE event sequence (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`)
- AC-P0-A.3 Mock error responses for: 401 (invalid auth), 429 (rate limit), 500 (server error), network failure (connection-reset)
- AC-P0-A.4 Integration test `npm run test:integration` (when Phase 0 builds out) runs capture-session.ts against the mocks via a test-only env var (e.g., `ANTHROPIC_API_BASE=http://localhost:<mock-port>`)
- AC-P0-A.5 Test harness runs in <30s wall-clock per `npm run test:integration` invocation

**Claim evidence**: test files exist + `npm run test:integration` exit 0 against mocks + coverage report shows ≥80% branch coverage for capture-handler.

**Anchor spec_ref**: this file + sub-section P0-A.

---

### P0-B — Streaming response handling

**Deliverable**: capture-session.ts handles Anthropic stream responses without crashing.

**ACs**:
- AC-P0-B.1 When request body contains `stream: true`, capture handler subscribes to Anthropic's SSE stream + reassembles full response from `content_block_delta` events
- AC-P0-B.2 Captured turn JSON carries `streaming: true` flag + the reassembled response body (same shape as non-streaming for downstream tooling)
- AC-P0-B.3 If stream truncates mid-response (network failure, client disconnect): explicit partial-response error path; captured turn records `stream_interrupted: true` + `bytes_received` + does NOT corrupt the session JSON
- AC-P0-B.4 Token counts on streaming responses match the post-stream `usage` field in the final `message_delta` SSE event (Anthropic publishes the canonical count there)
- AC-P0-B.5 Closes CHANGELOG-recorded crash bug; regression test in P0-A harness covers the crash scenario

**Claim evidence**: streaming-response integration test passes + manual run against a real Claude Code session demonstrates no crash.

**Anchor spec_ref**: this file + sub-section P0-B.

---

### P0-C — Token counting reliability

**Deliverable**: `client.messages.countTokens()` integration hardened; degrades gracefully if countTokens unavailable.

**ACs**:
- AC-P0-C.1 Every captured turn carries `input_tokens` (exact, from `countTokens`) + `output_tokens` (from response usage)
- AC-P0-C.2 If `countTokens` API returns error (e.g., model not yet supported by the count endpoint): fall back to a clearly-flagged estimate using `@anthropic-ai/tokenizer` package AND record `token_count_method: "estimated"` in the turn JSON (NEVER silently estimate)
- AC-P0-C.3 Repeated countTokens calls within a session for identical message arrays are cached (hash-keyed) to avoid redundant API spend; cache hit-rate logged to OTel
- AC-P0-C.4 Per-turn token counts are exposed to OTel as span attributes (`stratum.input_tokens`, `stratum.output_tokens`)
- AC-P0-C.5 Session-total token counts in the final session JSON are recomputed from per-turn (sum), not stored separately — single source of truth

**Claim evidence**: token-count integration test passes against mock; fallback path test passes against forced-error mock.

**Anchor spec_ref**: this file + sub-section P0-C.

---

### P0-D — Session JSON schema + semver versioning

**Deliverable**: schema definition file + version-stamp on every session JSON + migration scaffold for future schema changes.

**ACs**:
- AC-P0-D.1 `stratum/src/types/session.ts` (or `stratum/schemas/session-v0.1.0.ts`) defines the `CapturedSession` interface formally; current 35 LOC type is the v0.1.0 schema baseline
- AC-P0-D.2 Every session JSON file starts with `"schema_version": "0.1.0"` at top-level
- AC-P0-D.3 Schema migration scaffold at `stratum/scripts/migrate-session-schema.ts` reads a session JSON, dispatches by `schema_version` to a migrator function (v0.1.0 → v0.2.0 stub for future use), writes back to same path
- AC-P0-D.4 Schema-version invariant test: capture a session, parse it back, validate against schema definition; round-trip lossless
- AC-P0-D.5 Documentation: `stratum/docs/SESSION_SCHEMA.md` (new file) records the v0.1.0 schema with semver-bump rules for v0.2.0+

**Claim evidence**: schema-validate integration test passes against captured-session fixtures.

**Anchor spec_ref**: this file + sub-section P0-D.

---

### P0-E — Supabase storage backend wiring

**Deliverable**: every captured session JSON also written to Supabase `sessions` table (append-only, RLS-respecting).

**ACs**:
- AC-P0-E.1 `stratum/src/lib/supabase.ts` (already a stub) implements `writeSession(session: CapturedSession): Promise<void>` using `@supabase/supabase-js` v2+
- AC-P0-E.2 Storage write happens AFTER PII redaction (P0-F dep)
- AC-P0-E.3 Append-only enforced via Supabase RLS policy: only INSERT allowed on `sessions`; UPDATE/DELETE rejected at policy level (mirrors DevOPs `billing_records` pattern)
- AC-P0-E.4 Supabase migration order: this work appends migrations under `stratum/supabase/migrations/`; does NOT alter or reorder existing `20260406000000_initial_schema.sql`; new migration filename uses ISO timestamp post-2026-04-06 to maintain ordering
- AC-P0-E.5 Storage write failure does NOT block the proxy's forward to Anthropic — failures are logged + retried async; the captured JSON is also written to local `data/sessions/` as a durability backstop
- AC-P0-E.6 Configuration via env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (per Stratum CLAUDE.md). Service key NEVER logged.

**Claim evidence**: integration test against a local Supabase instance writes + reads back a captured session.

**Anchor spec_ref**: this file + sub-section P0-E.

---

### P0-F — PII redaction consumption

**Deliverable**: every captured payload routes through `observability/pii-redaction.ts` (DevOPs's existing redactor) BEFORE Supabase write. Stratum does NOT duplicate the regex patterns.

**ACs**:
- AC-P0-F.1 Capture handler imports `redactPII` from `observability/pii-redaction.ts` (or via a shared `@miltonadina/devops-pii` adapter if DevOPs publishes one)
- AC-P0-F.2 Redaction applied to: `request.messages[].content` (text + tool inputs), `request.system` (system prompt), `response.content[].text` (assistant text). NOT applied to model name, stop_reason, token counts (those are not PII).
- AC-P0-F.3 PII redactor exception → FAIL-CLOSED: drop the captured turn from the session JSON + emit `pii.redaction_failed` OTel event with reason; do NOT proceed to storage write
- AC-P0-F.4 Verbatim PII pattern coverage from `observability/pii-redaction.ts`: email, phone-us, ssn, cc, jwt, bearer, sk-key, aws-key (8 patterns). New patterns added to DevOPs's redactor automatically apply to Stratum capture — no Stratum-side patterns
- AC-P0-F.5 Test fixture in P0-A includes a payload with a planted email + a planted JWT; integration test asserts both are `[REDACTED-email]` and `[REDACTED-jwt]` in the storage-written record

**Claim evidence**: PII-roundtrip integration test passes; coverage of all 8 patterns verified via parametrized test.

**Anchor spec_ref**: this file + sub-section P0-F.

---

### P0-G — Observability event emission

**Deliverable**: session-start, session-end, session-error, turn-recorded events emit to DevOPs OTel collector.

**ACs**:
- AC-P0-G.1 OTLP exporter configured in Stratum src to send to localhost:4317 (grpc) or 4318 (http) per `observability/otel-config.yml`. Endpoint via env var `OTEL_EXPORTER_OTLP_ENDPOINT`.
- AC-P0-G.2 Events emitted: `stratum.session.start`, `stratum.session.end`, `stratum.session.error`, `stratum.turn.recorded`. Each carries baggage: `session_id` (uuid), `tenant_id` (uuid from `STRATUM_TENANT_ID` env), `schema_version`.
- AC-P0-G.3 `stratum.turn.recorded` event carries span attributes per AC-P0-C.4: `stratum.input_tokens`, `stratum.output_tokens`, `stratum.model`, `stratum.elapsed_ms`. NEVER carries `messages` content (PII).
- AC-P0-G.4 Event schema is forward-compatible with DevOPs's existing OTel attribute conventions (snake_case for attributes; `stratum.` namespace for Stratum-emitted)
- AC-P0-G.5 OTel exporter failure → graceful degradation: log the failure to a local log file + continue session capture (storage + Anthropic forward unaffected). Do NOT block proxy on observability outage.

**Claim evidence**: end-to-end test captures a session, asserts OTel spans/events arrive at a test OTLP receiver with expected attributes.

**Anchor spec_ref**: this file + sub-section P0-G.

---

## §5 — Cross-area constraints (load-bearing)

- **P0-F ← `observability/pii-redaction.ts`** — consume, do not duplicate. This is the convergence point from `.workflow/state/stratum-audit/02-overlap.md` § PII redaction. If Stratum implements its own redactor, both will drift and the convergence is lost.
- **P0-G ← DevOPs observability event schema** — emit compatible events. New event types must register with DevOPs's existing OTel attribute conventions before Stratum work introduces them.
- **P0-E ← Supabase migration order** — append migrations with monotonically-increasing ISO timestamps; do NOT alter `20260406000000_initial_schema.sql`. Reuse RLS policy patterns from DevOPs schema (if DevOPs ever adopts Supabase; currently only Stratum has Supabase deps — this constraint future-proofs the alignment).
- **P0-B blocks P0-C** — token counting on a crashed stream is meaningless. P0-C tests against P0-B's stream-handling code paths.
- **P0-A unblocks everything** — no implementation REQ can close without the test harness. P0-A is the critical path's entry node.
- **PB-18 side-effect (Session 10 Phase A)** — fastify 4→5 major bump may require capture-session.ts API adjustments. Surface at first `npm install` in stratum/; tag as part of P0-A scope (test harness invocation pattern).
- **uuid import cleanup** — capture-session.ts has a dead `uuid` package import (uses `node:crypto.randomUUID()`). Remove during P0-A refactor.

---

## §6 — Out-of-scope for Phase 0 (deferred per Option B)

- **Stratum Phase 1** — measurement proxy (full Cloudflare Worker deployment, dashboard at `/dashboard`, waste detection heuristics). Separate spec for Session 11+N.
- **Stratum Phase 2** — CQ-Extended KadaneDial pruner — **DEFERRED to post-v0.3.0** per Option B locked decision (`.workflow/state/stratum-audit/04-gap-roadmap-deltas.md`).
- **Stratum Phase 3** — three-tier memory schemas + Llama extractor + Pinecone + Neo4j. Separate spec.
- **Stratum Phases 4-6** — ZK-Context + TEE / Git-attestation audit / Token-arbitrage billing — **DEFERRED post-v0.3.0**.
- **Streaming response replay** — capability to replay captured streaming sessions for testing. Post-v0.3.x.
- **ZK-Context client-side encryption** — Phase 4+; not personal-tool relevant.
- **Multi-provider proxy** — only Anthropic in Phase 0. OpenAI, Gemini, etc. → post-v0.3.0 if ever.

---

## §7 — Open questions (BLOCK Session 11 implementation start)

These need user-confirmed answers before Session 11 P0-A can begin. Do NOT improvise answers; surface at Session 11 startup if any remain open.

**Q1 — Supabase scope**:
- (a) Local Supabase only (`supabase start` on operator's machine; no remote project) — simplest, no cloud cost
- (b) Staging-Supabase only (a real Supabase project, free-tier, for capture proxy) — closer to Phase 1 production posture
- (c) Both — local for dev iteration, staging for capture-in-anger

**Q2 — Token-counting cadence**:
- (a) Per-turn live (call `countTokens` synchronously before forwarding to Anthropic) — exact + slow; adds latency
- (b) Batched at session-end (collect message arrays, count once at session close) — fast forward path; defers count cost
- (c) Both — live for the current turn's `input_tokens` (already what the SDK gives back in `response.usage`), batched-recompute for cache hit-rate accounting

**Q3 — Session JSON retention policy** (for personal-tool):
- (a) 90 days then auto-prune
- (b) Indefinite retention
- (c) Size-cap (e.g., keep last 1 GB of sessions; FIFO)
- (d) Operator-controlled (config flag)

**Q4 — Anthropic API base URL override mechanism** (so the proxy is testable + the operator can route through Stratum):
- (a) `ANTHROPIC_API_BASE` env var — convention from many Anthropic SDK wrappers
- (b) Config file at `stratum/config.yml`
- (c) CLI flag at proxy invocation
- (d) Combination (env > config > flag fallback)

**Q5 — PB-18 fastify 4→5 follow-through**:
- (a) Update capture-session.ts to Fastify 5 APIs as part of P0-A (test-harness scope)
- (b) Tag as a separate sub-task (P0-A.0 — pre-A migration)
- (c) Run `npm install` in stratum/ at Session 11 start, observe what breaks, decide then

**Q6 — Tenant scope for personal-tool**:
- (a) Single-tenant (no `organizations`/`developers` table use; just one operator, one tenant_id)
- (b) Multi-tenant infrastructure preserved (use existing schema; one row in `organizations` for personal use) — closer to Phase 1+ posture

**Q7 — OTel exporter dependency**:
- (a) Hard dep — requires DevOPs OTel collector running locally for Phase 0 capture
- (b) Soft dep — capture works without OTel; events log to file if collector unreachable (graceful degradation per AC-P0-G.5)

---

## §8 — Lessons-in-force for Phase 0 implementation (carry-forward)

Discipline rules from prior sessions that apply to Phase 0 work:

1. **Read-all-first IMMEDIATELY before each Edit/Write** — Session 4-5 finding; saved-memory rule `feedback_read_all_first.md`
2. **JS regex no PCRE** — `[\s\S]` for multiline, not `.`; verified bite (Session 5 + Session 9 repeats) — saved-memory `feedback_js_regex_no_pcre.md`
3. **Capture exit codes via `$?` after pipes** — `| tee` masks upstream exit codes (Session 7.5 finding)
4. **AP-5 Proof Theater** — verify positive results with explicit exit codes, not just stdout grep (Session 6+)
5. **AP-5 Scheduler-Failure** — workflow runs that complete in <10s with "failure" conclusion often have empty logs because failure was at scheduler level (billing, quota, queue rejection), not runner. **Check workflow annotations FIRST**, not logs (Session 9 finding + Session 10 Phase A re-confirmation: billing block continues across PR-triggered workflows too)
6. **Single-source-of-truth merge flow** — do NOT cherry-pick across long-lived branches; creates `add/add` conflicts when both branches independently evolve the cherry-picked file (Session 9 Phase E lesson)
7. **Version-SOT grep before any version-affecting commit** — `git ls-files | xargs grep -l <OLD_VERSION>` to catch lagging files (Session 9 Phase F lesson; caught package.json + plugin.json drift behind VERSION.md)

---

## §9 — Pre-merge checklist for v0.3.x (new — Session 9 lesson)

Apply at every Stratum Phase 0+1+3 PR before merge to main:

- [ ] All claims emitted + validated (`npm run validate:claims -- --all` → matching count)
- [ ] All affected version strings updated (grep for OLD version across `git ls-files`; package.json, .claude-plugin/plugin.json, governance/VERSION.md grep-confirmed consistent if version touched)
- [ ] Cosign signatures fresh against latest content (any SKILL.md updates trigger PB-13-class refresh requirement)
- [ ] Dependabot alerts triaged (no open high-severity findings without disposition)
- [ ] Branch flow per PB-17 outcome (PR-based for v0.3.x; no direct-push)
- [ ] CI checks pass on PR before merge (gated on GitHub Actions billing being unblocked — Session 9/10 finding)
- [ ] Linear history preserved (squash-merge or rebase-merge; no merge commits)

---

## §10 — Change log

- 2026-05-25 (Session 10 Phase C) — Spec authored. Awaiting user answers on §7 open questions (Q1–Q7) before Session 11 implementation begins.

---

## Cross-references

- Authoritative scaffold state: `.workflow/state/stratum-audit/01-stratum-state.md`
- Option B scope decision: `.workflow/state/stratum-audit/04-gap-roadmap-deltas.md`
- DevOPs PII redactor (P0-F consumer source): `observability/pii-redaction.ts`
- DevOPs OTel collector config (P0-G integration surface): `observability/otel-config.yml`
- Stratum CLAUDE.md (operating rules inside stratum/ subtree): `stratum/.claude/CLAUDE.md`
- Stratum's own roadmap (Phase 0 acceptance criteria source): `stratum/docs/ROADMAP.md`
- Phase 2 area-spec format precedent: `.workflow/state/plans/phase-2-C-prompt-injection-hardening.md`
- Session 10 Phase A PB-18 triage (informs PB-18 follow-through in Q5): `.workflow/state/security/pb18-dependabot-triage.md`
- Phase 2 sealed state: `governance/changelog/PHASE-2-CLOSURE.md`
- Launch readiness methodology: `docs/LAUNCH_READINESS.md`
