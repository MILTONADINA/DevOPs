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
| Streaming support in capture-session.ts | **NONE** (zero streaming code path; non-streaming `axios.post` only). The prior reference to a "streaming-response crash in CHANGELOG" was traced Session 13 to a fictional entry inside `stratum/CHANGELOG.md`'s Format Reference example block — not a real `[Unreleased]` entry. Streaming is greenfield work in P0-B (see §3). |
| License | MIT (note: package.json name is "startum" — Stratum/Startum typo persists upstream; out of DevOPs scope) |
| Dependencies post-PB-18 bump | fastify `^5.8.3`, uuid `^11.1.1` (was 4.x/9.x; vulnerable per Dependabot, FIX-PREVENTIVE applied) |
| Installed state | NO lockfile, NO `node_modules/`, never `npm install`'d in this repo |

**What capture-session.ts does today**: Fastify listening on port 4090, intercepts `POST /v1/messages`, calls `client.messages.countTokens()` for exact input-token measurement, forwards to real Anthropic API, captures (request, response, token_counts, elapsed_ms) per turn, writes session JSON to `data/sessions/session-<uuid>.json` (gitignored). Uses `randomUUID()` from `node:crypto` (NOT the `uuid` package — the `uuid` import is dead code).

**Streaming support is not yet implemented (greenfield work for P0-B)**: capture-session.ts has zero streaming code path — it uses `axios.post()` against `https://api.anthropic.com/v1/messages` non-streaming only. There is no `messages.stream()` call, no SSE parser, no `text/event-stream` handling. Session 13 traced the prior reference to a "streaming crash in CHANGELOG" to a fictional entry inside `stratum/CHANGELOG.md`'s Format Reference example block (removed in Session 13 cleanup; see `stratum/CHANGELOG.md` history). P0-B is therefore greenfield streaming implementation, not a crash fix. Effort estimate revised upward (Session 13) to reflect honest reality.

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
| **P0-A** | Test harness + mock Anthropic responses (**non-streaming only**; error paths included) | ~12 | none | `stratum-phase-0-capture` |
| **P0-B** | **Streaming support implementation (greenfield)** — SSE detection, parsing, chunk passthrough, accumulated-session-JSON, comprehensive test coverage. Re-scoped Session 13 (was ~8h crash-fix; corrected to honest greenfield estimate) | ~18 | P0-A | `stratum-phase-0-capture-streaming` |
| **P0-C** | Token counting reliability hardening (`countTokens` integration; cache for repeated counts; degrade-gracefully on countTokens API failure) | ~6 | P0-A | `stratum-phase-0-capture-token-counting` |
| **P0-D** | Session JSON schema + semver versioning + migration scaffolding | ~4 | none | `stratum-phase-0-capture-schema` |
| **P0-E** | Supabase storage backend wiring (append-only `sessions` write; RLS; reuse DevOPs migration patterns) | ~10 | P0-D + DevOPs schema | `stratum-phase-0-capture-storage` |
| **P0-F** | PII redaction consumption from `observability/pii-redaction.ts` (NOT duplication) | ~6 | P0-E + `observability/pii-redaction.ts` | `stratum-phase-0-capture-pii` |
| **P0-G** | Observability event emission (OTLP-compatible spans; baggage propagation per `observability/otel-config.yml`) | ~6 | P0-F + DevOPs event schema | `stratum-phase-0-capture-otel` |

**Total: ~62h** (revised Session 13 from ~52h to reflect P0-B greenfield reality). Still within the 30-80h range tolerance. The +10h delta is honest cost transparency, not scope expansion — same deliverable, accurate estimate. If actual execution diverges >50% from ~62h, STOP and surface — Option B's full-project denominator (currently 996h with 619h Phase 3 budget) may need revision.

### P0-B re-scope detail (Session 13)

CHANGELOG previously referenced a "streaming crash" entry inside a format-reference example block (removed Session 13). `capture-session.ts` currently uses `axios.post()` non-streaming only — zero streaming code exists. P0-B is therefore **greenfield streaming implementation**, NOT a crash fix.

P0-B scope (binding):
- Detect `stream: true` in incoming request body (or `Accept: text/event-stream` header)
- Forward to Anthropic Messages API with streaming enabled (`@anthropic-ai/sdk` `messages.stream()` or equivalent fetch-based SSE)
- Parse Server-Sent Events (SSE) — `event: <type>\ndata: {...}\n\n` framing per Anthropic streaming spec
- Forward chunks to client preserving streaming semantics (proxy passthrough; do not buffer-and-respond)
- Accumulate full session JSON from streaming chunks (`message_start` → `content_block_start` → `content_block_delta` × N → `content_block_stop` → `message_delta` → `message_stop`)
- Handle stream errors: network drop mid-stream, malformed chunks, client-side abort (`AbortController`), partial stream, Anthropic-side error events
- Comprehensive vitest coverage (per Q8.1): text streaming, `tool_use` streaming, multi-turn streaming, error paths, abort handling

---

## §4 — Acceptance criteria per REQ

### P0-A — Test harness + mock Anthropic responses (non-streaming only)

**Deliverable**: vitest-based test harness exercising capture-session.ts's existing non-streaming proxy path with comprehensive coverage. Streaming tests are **explicitly out of scope** for P0-A; they live in P0-B's coverage. The mock surface must include an explicit scope-guard that throws if a test attempts to invoke `messages.stream()`.

**Test runner**: vitest (per Q8.1). Migration from declared-but-unused jest scaffold is part of P0-A.

**ACs (Session 13 revised under production-grade quality bar)**:
- AC-P0-A.1 Mock Anthropic non-streaming response fixtures exist at `stratum/tests/fixtures/anthropic/*.json` covering: simple text, single tool_use, mixed-content (text+tool_use), multi-turn, 4xx error, 5xx error
- AC-P0-A.2 **Streaming tests are explicitly EXCLUDED from P0-A.** The mock SDK surface MUST raise on `messages.stream()` invocation with an error message naming P0-B as the responsible scope. Streaming fixtures (e.g., `streaming.sse` referenced in prior revisions) live in P0-B's coverage, not here.
- AC-P0-A.3 Mock error responses for: 401 (invalid auth), 429 (rate limit), 500 (server error), network failure (connection-reset), malformed-JSON response
- AC-P0-A.4 vitest test suite invokable via `npm test` (in `stratum/`) returns exit 0 against fully-mocked Anthropic surface; no real network calls
- AC-P0-A.5 Test harness runs in <30s wall-clock per full `npm test` invocation
- AC-P0-A.6 Coverage thresholds (production-grade bar): `scripts/capture-session.ts` statements ≥85%, branches ≥80%, functions ≥90%, lines ≥85%
- AC-P0-A.7 Test set covers: proxy passthrough (non-streaming), tool_use forwarding, mixed-content forwarding, session-JSON capture artifact shape, multi-turn forwarding, error paths (4xx/5xx/network/malformed), tenant isolation (default `"personal"` per Q6), token counting (per-turn `countTokens` invocation per Q2), OTel soft-dep (Q7: stderr fallback when endpoint empty/unreachable), config resolution (Q4: env-var primary), concurrent-session isolation, graceful shutdown (SIGTERM handler + in-flight drain). Total: 11 test files, ~30-40 cases
- AC-P0-A.8 Mock `@anthropic-ai/sdk` includes: `messages.create` (configurable response from fixture loader), `messages.countTokens` (returns deterministic count via JSON-length heuristic); `messages.stream` explicitly throws per AC-P0-A.2
- AC-P0-A.9 Mock fastify 5 request/reply shapes: `buildMockRequest`, `buildMockReply` with chainable recorders; `inject()` helper for full-lifecycle integration tests

**Claim evidence**: vitest exit 0 + coverage report meeting all four thresholds + explicit AC → test-file mapping table + negative anchor (no jest, ts-jest, @types/jest in package.json; no streaming code path / streaming test in suite).

**Anchor spec_ref**: this file + sub-section P0-A.

---

### P0-B — Streaming support implementation (greenfield)

**Deliverable**: capture-session.ts gains a complete streaming code path, from SSE detection through chunk passthrough through accumulated-session-JSON, with comprehensive vitest coverage. Re-scoped Session 13 from "fix CHANGELOG crash" (which referenced a fictional CHANGELOG entry) to "implement streaming for the first time."

**Test runner**: vitest (per Q8.1).

**ACs (Session 13 revised under production-grade quality bar)**:
- AC-P0-B.1 Streaming detection: capture handler routes to streaming path when EITHER request body contains `stream: true` OR `Accept: text/event-stream` header is present. Non-streaming requests continue using the non-streaming path established in P0-A.
- AC-P0-B.2 SSE forwarding: streaming chunks pass through to the client preserving streaming semantics — the client sees a streaming response, NOT a buffered-then-sent response. Use Node 18+ `ReadableStream` + fastify 5's reply-stream API. Latency-to-first-token must be ≤ Anthropic's own (overhead ≤50ms p95).
- AC-P0-B.3 Session JSON accumulation: streaming chunks accumulate into the same `CapturedSession` shape as non-streaming. Event sequence handled: `message_start` → `content_block_start` → `content_block_delta` × N → `content_block_stop` (× M for multi-block) → `message_delta` → `message_stop`. Captured turn JSON carries `streaming: true` flag + the reassembled response (same downstream shape as non-streaming).
- AC-P0-B.4 Token counts on streaming responses match the post-stream `usage` field in the final `message_delta` SSE event (Anthropic publishes the canonical count there). Per-turn `countTokens` (per Q2) is invoked PRE-stream for input tokens.
- AC-P0-B.5 Stream-error handling (all explicit, fail-CLOSED on session-JSON corruption risk):
  - Network drop mid-stream → captured turn records `stream_interrupted: true` + `bytes_received` + last-completed-event-type; partial reassembled content preserved; client receives a structured error event before close
  - Malformed SSE chunk (non-JSON data field, missing newlines, etc.) → log to stderr; skip the chunk; continue if recoverable, abort if cumulative-malformed-count exceeds threshold (default 3)
  - Client-side abort (`AbortController`) → upstream connection closed; session JSON marked `client_aborted: true`; no further chunks accumulated
  - Anthropic-side error event in stream → forwarded to client; session JSON records the error
- AC-P0-B.6 Comprehensive vitest coverage (P0-B authors all streaming tests): text-only streaming, tool_use streaming, mixed-content (text + tool_use) streaming, multi-turn streaming, abort handling, all 4 error paths from AC-P0-B.5
- AC-P0-B.7 Streaming fixtures live at `stratum/tests/fixtures/anthropic-streams/*.sse` (SSE wire format, not JSONL). Coverage: simple-text-stream, tool-use-stream, mixed-content-stream, multi-turn-stream, abort-mid-stream, malformed-chunks, network-drop, anthropic-error-event.

**Claim evidence**: streaming integration tests passing + manual smoke against a real Claude Code session demonstrates first-token latency overhead ≤50ms p95 + session JSON reassembles correctly from a captured real stream.

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

## §7 — Resolved decisions (Session 11 user-confirmed 2026-05-25)

> Section history: this section was originally titled **§7 — Open questions** (authored Session 10 Phase C, 2026-05-25) and held 7 numbered questions Q1-Q7 blocking implementation start. Session 11 Phase A replaced the open-question state with the binding resolutions below.

User-confirmed answers to all 7 open questions. Each carries a one-line rationale + a `DECIDED:` prefix marking the binding choice. P0-A through P0-G acceptance criteria reflect these resolutions (cross-checked in §9 pre-merge checklist).

**Q1 — Supabase scope** → **DECIDED: local-only**. Staging deferred to v0.4.x; adds connection-string + CI-secret sprawl that doesn't pay back at v0.3.x. Local-only via `supabase start` on the operator's machine; no remote project, no cloud cost.

**Q2 — Token-counting cadence** → **DECIDED: per-turn live** via `@anthropic-ai/sdk` `messages.countTokens()`. countTokens API cost is negligible at personal-tool volume; live counts surface context-window pressure mid-session. Batched recompute deferred to v0.4.x optimization if API costs ever matter.

**Q3 — Session JSON retention policy** → **DECIDED: indefinite, with stderr warning at 5GB cumulative and again at 10GB**. Personal-tool framing = sessions ARE the memory. Real pruning belongs in Stratum Phase 2 (KadaneDial, DEFERRED post-v0.3.0 per Option B). The size-cap warning is a *forcing function* for revisiting retention policy when sessions actually start filling disk (expected 6–12 months heavy use), NOT a fix. Surface for visibility; no retention enforcement in P0.

**Q4 — Anthropic API base URL override mechanism** → **DECIDED: env var primary (`ANTHROPIC_BASE_URL`), config-file secondary override (`stratum.config.json` `anthropicBaseUrl` key), no CLI flag**. Matches `@anthropic-ai/sdk` convention. CLI flag would add surface area without a clear use case; env-first matches operator muscle memory for the Anthropic ecosystem.

**Q5 — PB-18 fastify 4→5 follow-through** → **DECIDED: bundle into P0-A**. Lockfile already has fastify ^5.8.3 (per Session 10 Phase A PB-18 closure). Test harness writes against fastify 5 from the start. A separate sub-task would mean writing throwaway fastify-4 mocks; mocking against the version we'll actually run is correct.

**Q6 — Tenant scope for personal-tool** → **DECIDED: preserve multi-tenant SHAPE, single-tenant ENFORCEMENT**. Schema retains `tenant_id` column defaulting to `"personal"` (no `organizations`/`developers` row population required in P0). OTel events emit with `tenant.id` baggage (matches existing DevOPs observability pattern in `external-content-boundary.ts`). No RLS-by-tenant enforcement in v0.3.x. Preserves Phase 1+3 integration path; zero cost now; doesn't paint into a corner.

**Q7 — OTel exporter dependency** → **DECIDED: soft dep with graceful degradation**. If `OTEL_EXPORTER_OTLP_ENDPOINT` is unreachable (unset, network failure, collector not running), capture-session continues with stderr-fallback log emission. Hard dep is the wrong default for a tool that runs on laptops with flaky networks. AC-P0-G.5 in §4 already encodes this; reaffirmed here.

**Q8 — Test runner** → **DECIDED: jest** (Session 12 user-confirmed 2026-05-25 under zero-churn / personal-tool prior). `stratum/package.json` already declares `jest ^29.7.0` + `ts-jest ^29.1.5` + a `jest:{}` config block (preset `ts-jest`, testEnvironment `node`, moduleNameMapper `@/*` → `src/*`). Migration to vitest costs devDep churn + config rewrite + breaks consistency with the upstream Stratum scaffold without payoff at personal-tool scope. The "vitest preferred" default from the Session 11 prompt was a greenfield default — it does not override an existing functional scaffold.

> **SUPERSEDED by Q8.1 below.** Q8 is retained as audit trail; Q8.1 is the binding decision from Session 13 forward.

**Q8.1 — Test runner recalibration** → **AMENDED: vitest** (Session 13 user-confirmed 2026-05-25/26 under production-grade quality bar).

Rationale: Q8 baked jest under the zero-churn / personal-tool prior. Session 13 recalibrates under a production-grade prior. vitest is architecturally superior for an ESM-first TypeScript project: native ESM matches `@anthropic-ai/sdk`'s ESM-first nature; no ts-jest transformer brittleness; ~3-5× faster execution; cleaner mocking ergonomics for ESM modules; modern watch mode with file-graph-aware reruns. Migration cost (~30-60 min) is incurred ONCE before any concrete tests are authored; deferred migration would compound across 10+ test files. Q8 (jest) is RETAINED in this spec as audit trail; the BINDING test runner from Session 13 forward is **vitest**.

**Carry-forward**: vitest is also the binding test runner for stratum/ Phase 1 + Phase 3 specs (no per-phase test-runner divergence). All future test-related acceptance criteria reference vitest.

### Resolution provenance

- Confirmation date: 2026-05-25 (Q1-Q7 baked Session 11 Phase A; Q8 baked Session 12 Phase A — same physical day)
- Confirming party: Milton Adina (user)
- Strategist context: Q1-Q7 originated from strategist-side analysis (user confirmed verbatim); Q8 surfaced by Session 11 Phase B STOP after discovering the existing jest scaffold, user-decided in Session 12 prompt
- Decisions are BINDING for Phase 0 implementation (P0-A through P0-G); override requires a new spec revision + claim emission

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
- [ ] §7 resolutions (Q1-Q8 + Q8.1) reflected in P0-A through P0-G acceptance criteria — no implementation diverges from binding decisions without a spec revision. Q8 (jest) is the audit-trail entry; Q8.1 (vitest) is the binding test runner.

---

## §10 — Change log

- 2026-05-25 (Session 10 Phase C) — Spec authored. Awaiting user answers on §7 open questions (Q1–Q7) before Session 11 implementation begins.
- 2026-05-25 (Session 11 Phase A) — §7 resolved with user-confirmed Q1-Q7 decisions ("yes for both" gates). Q1 local-only Supabase; Q2 per-turn live countTokens; Q3 indefinite retention + 5/10GB stderr warning; Q4 env-var primary + config-file secondary; Q5 fastify 4→5 bundled into P0-A; Q6 multi-tenant shape + single-tenant enforcement; Q7 OTel soft dep + stderr fallback. P0-A through P0-G acceptance criteria reflect these resolutions. Session 11 also attempted PB-13 closure via release-sign.yml re-dispatch against v0.2.0 (run 26414947646); failed at scheduler in 5s with same billing annotation as Session 9 + Session 10 Phase A — billing block persists; PB-13 stays BLOCKED.
- 2026-05-25 (Session 12 Phase A) — §7 Q8 baked: test runner = jest (existing `stratum/package.json` scaffold; no vitest migration). §9 pre-merge checklist updated to "Q1-Q8". PB-13 re-attempted ONCE per Session 12 prompt's no-retry policy: run `26416394799` failed at scheduler in 5s with 0 steps — FOURTH consecutive billing-blocked failure (Sessions 9, 10, 11, 12). Logged as PB-13.3 (third confirmed re-attempt failure post the initial Session 9 Phase F failure). Escalation: user-side spending-limit configuration at github.com/settings/billing/spending_limit. Phase B (P0-A scaffolding) deferred pending strategist resolution of two pre-flight findings: (1) `stratum/CHANGELOG.md` streaming-crash entry is fictional (lives inside the "Format Reference" example code block, not a real `[Unreleased]` entry); (2) `stratum/scripts/capture-session.ts` has no streaming code path — `axios.post('/v1/messages', body)` non-streaming only, no `messages.stream()`, no SSE handling. The crash-replication.jsonl fixture cannot be reconstructed because no crash exists yet.
- 2026-05-25/26 (Session 13 Phase A) — Recalibration sweep under production-grade quality bar. §7 Q8.1 amendment baked: test runner = **vitest** (supersedes Q8 jest; Q8 retained as audit trail). §3 P0-B re-scoped from "fix CHANGELOG crash" (~8h) to "greenfield streaming implementation" (~18h); P0 total envelope 52h → 62h. §4 acceptance criteria clarified: P0-A streaming tests/fixtures moved to P0-B; P0-A coverage thresholds set (statements ≥85% / branches ≥80% / functions ≥90% / lines ≥85%); P0-A test-set enumerated (11 files). §1 honesty fix: removed the misleading "Known defects | Streaming-response crash" entry that traced to a fictional CHANGELOG entry; replaced with accurate "Streaming support in capture-session.ts: NONE — greenfield work for P0-B." Companion CHANGELOG cleanup: `stratum/CHANGELOG.md` format-reference example block removed (was the root cause of the Session 12 unexecutable T-B6 prompt). PB-19/PB-20/PB-22 claim-check rots fixed via methodology refactor + pure-Node rewrite. PB-21 triaged: stays coupled to PB-13 (no honest decoupling available — refactor would misrepresent signature integrity). PB-14 closed (actions/setup-node@v5 SHA bump). PB-15 closed (GAP_61 row annotation pass). PB-16 promoted to dedicated session (gating: user-side signing-key generation + GitHub upload). PB-13 NOT attempted Session 13 (gated on explicit spending-limit signal). LR refreshed: v0.2.0 ~95%, full-project ~15.7% under new ~1006h denominator.

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
