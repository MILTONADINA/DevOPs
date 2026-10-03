# Stratum architecture

This document describes what the Stratum code does today. Design documents
such as `MEMORY_ARCHITECTURE.md` and `AUDIT_ENGINE.md` describe the target
design; where the code differs, this document follows the code. Citations use
repo-relative `path:line`. It describes code paths and reports no test run.

- The hosted Supabase project is retired. Development uses a local Compose
  stack (ADR-0020). No production deployment topology is chosen.
- Pruning does not change any request. The pruner runs only in shadow mode.
- No TEE enclave exists. `runtime/src/proxy/tee/gateway.ts` is a TODO stub.

## 1. Components

| Component | Code | What it does today |
|---|---|---|
| Proxy entry | `runtime/src/proxy/index.ts` | Reads env, picks the mode, builds the app, listens, drains on SIGTERM/SIGINT |
| App factory | `runtime/src/proxy/app.ts` | Builds a Fastify instance. It registers only the routes whose deps are supplied |
| Messages route | `runtime/src/proxy/routes/messages.ts` | `POST /v1/messages`: count, gate, forward, capture, journal usage, memory, shadow |
| Provider router | `runtime/src/proxy/providers/router.ts` | Maps a model id to Anthropic, OpenAI, OpenRouter, Gemini or a local server |
| Capture store | `runtime/src/proxy/capture.ts` | Redacts each turn (fail-closed) and writes a session JSON file |
| Shadow observer | `runtime/src/proxy/shadow-observer.ts` | Runs the pruner on a private window and logs counts. Never alters traffic |
| Memory | `runtime/src/memory/` | Tier-1 RAM window, Tier-2 fact tables, Tier-3 graph and vectors |
| Pruner | `runtime/src/pruner/` | KadaneDial selection, encoder, supersession. Not in the request path |
| Audit engine | `runtime/src/audit/` | Deterministic git attestation of facts. LLM tiers are not wired |
| Usage | `runtime/src/usage/` | Durable outbox, unsigned records, pinned estimated prices and token summaries |
| Legacy payment code | `runtime/src/billing/` | Invoice/Stripe modules retained until C3; no longer the team usage path |
| Storage | `runtime/supabase/` | Migrations and the local Compose stack |

## 2. Entry points and modes

`npm run dev` runs `tsx src/proxy/index.ts` (`runtime/package.json:9`). The
server binds `127.0.0.1` unless `DEVOPS_PROXY_HOST` is set (`HOST` is a
deprecated one-release alias; `runtime/src/proxy/index.ts:159-165`) and
listens on `PORT`, default 4080 (`runtime/src/proxy/network-settings.ts:73-81`, `runtime/src/proxy/index.ts:543`).

**Personal mode** is the default. The base options hold the messages deps and
the dashboard reader (`runtime/src/proxy/index.ts:489-496`). No auth gate is
registered, and the rate limit is per IP, default 100 per minute
(`runtime/src/proxy/app.ts:377-379`, `runtime/src/proxy/network-settings.ts:104-106`). Personal mode needs at least one
configured provider (`runtime/src/proxy/default-deps.ts:26-29`).

**Commercial mode** requires `CQ_COMMERCIAL=true` (or `1`) and both Supabase
settings. Startup requires persistent usage storage and refuses Vercel;
`CQ_BILLING_SIGNING_SECRET` is not required (`runtime/src/proxy/index.ts`,
`assertCommercialStartup` and `buildStartOptions`). Commercial mode adds:

- An API-key gate on `/v1/*` (`runtime/src/proxy/index.ts:397`). The key comes
  from `Authorization: Bearer` or `x-api-key` and is looked up by SHA-256 hash
  among active keys (`runtime/src/proxy/auth.ts:34-36`, `runtime/src/proxy/auth.ts:45`,
  `runtime/src/proxy/auth.ts:72-75`).
- Config, memory, usage, sessions and webhook APIs (`runtime/src/proxy/index.ts:398-403`).
- Per-org request limits by plan (`runtime/src/proxy/app.ts:349-355`,
  `runtime/src/proxy/rate-limit-tiers.ts:20-25`). The sessions dependency reads the plan
  for these limits and the token budget. A lookup error falls back to `starter` (`runtime/src/proxy/index.ts:411-418`).
- A per-org token budget and the fsynced usage outbox
  (`runtime/src/proxy/index.ts:444`, `runtime/src/proxy/index.ts:447-455`).
- Optional local fact extraction and shadow observation
  (`runtime/src/proxy/index.ts:423-440`, `runtime/src/proxy/index.ts:456-465`).

In development, "Supabase" means the local gateway at `127.0.0.1:54321`
(section 10). `runtime/vercel-src/entry.ts` builds the same app for a
serverless function; startup fails there in commercial mode
(`runtime/vercel-src/entry.ts:17-18`, `runtime/vercel-src/entry.ts:33-35`).
`runtime/src/proxy/worker.ts` is a Cloudflare Worker adapter whose runtime and
deploy are not verified (`runtime/src/proxy/worker.ts:7-10`).

## 3. Request flow

```mermaid
flowchart TD
  C["Client (Anthropic-shaped request)"] --> AU{"Commercial mode?"}
  AU -- "yes" --> G["Auth gate: hashed API key to orgId"]
  AU -- "no" --> RL["Rate limit (per IP)"]
  G --> RLP["Rate limit (per org plan)"]
  RL --> V["Validate body: messages[] present"]
  RLP --> V
  V --> TC["Pre-flight token count (exact or estimated)"]
  TC --> TB{"Token budget OK?"}
  TB -- "no" --> R429["429 rate_limit_error"]
  TB -- "yes" --> CV["Resolve conversation (commercial)"]
  CV --> RT["Router: provider + native model"]
  RT --> UP["Upstream provider"]
  UP --> ERR{"Status >= 400?"}
  ERR -- "yes" --> PASS["Pass upstream error through, no capture"]
  ERR -- "no" --> CAP["Capture: redact, fail-closed, write session JSON"]
  CAP --> USE["Journal usage to fsynced outbox (commercial)"]
  USE --> OK["Response to client"]
  USE --> MEM["Async: local fact extraction -> Tier-2"]
  USE --> SH["Async: shadow observer -> log metric"]
```

Steps for the non-streaming path (`runtime/src/proxy/routes/messages.ts:401-486`):

1. **Auth and rate limit.** The auth hook runs before any route
   (`runtime/src/proxy/app.ts:342-344`). The limiter is registered after it so
   it can read `req.orgId` (`runtime/src/proxy/app.ts:346-381`).
2. **Token count.** The route asks the router's counter. Anthropic models get
   the SDK's exact count when an Anthropic key exists. Other models get a
   chars/4 estimate flagged `estimated` (`runtime/src/proxy/providers/router.ts:192-216`).
   A count failure also yields `estimated` (`runtime/src/proxy/routes/messages.ts:420-425`).
3. **Token budget.** Commercial only. An over-budget org gets a 429. A budget
   lookup error lets the request through (`runtime/src/proxy/routes/messages.ts:197-213`).
4. **Conversation.** Commercial only. The server resolves or mints a
   conversation id and returns it in `x-cq-conversation-id`
   (`runtime/src/proxy/routes/messages.ts:75-104`).
5. **Forward.** The router picks the provider and forwards the body. The
   client's `anthropic-version` and `anthropic-beta` headers pass through
   (`runtime/src/proxy/routes/messages.ts:147-155`). A transport error returns
   502. An upstream 4xx/5xx is passed through and not captured
   (`runtime/src/proxy/routes/messages.ts:434-448`). The non-streaming call
   has a total timeout, default 120 s (`runtime/src/proxy/forward.ts:141-144`).
6. **Capture and PII redaction.** The capture store redacts messages, system,
   tools and response with `redactValue` from `observability/pii-redaction.ts`.
   If redaction throws, the turn is dropped and nothing unredacted is written
   (`runtime/src/proxy/capture.ts:133-150`). Redaction applies to the capture
   file only. The upstream request is forwarded unchanged.
7. **Usage.** The recorded input count is the upstream `usage.input_tokens`,
   with the pre-flight count as a fallback (`runtime/src/proxy/routes/messages.ts:462`).
   In commercial mode the event is journaled before the response is sent. If
   the journal fails, the client gets a 503 (`runtime/src/proxy/routes/messages.ts:477-479`).
8. **Memory and shadow.** After the usage journal, the route starts fact
   extraction and shadow observation without awaiting them
   (`runtime/src/proxy/routes/messages.ts:480-482`). Extraction reads the last
   user text and the assistant text from the original request and response,
   not from the redacted capture (`runtime/src/proxy/routes/messages.ts:43-46`).

The streaming path follows the same order (`runtime/src/proxy/routes/messages.ts:257-386`).
It keeps reading upstream after a client disconnect so the final
`message_delta` usage is counted (`runtime/src/proxy/routes/messages.ts:297-302`).
With the outbox enabled it holds back the last chunk and any bytes after
`message_stop` until the usage journal succeeds
(`runtime/src/proxy/routes/messages.ts:306-315`, `runtime/src/proxy/routes/messages.ts:372-375`).

On shutdown, Fastify waits for in-flight requests, then the route awaits
pending memory and shadow writes and closes the outbox
(`runtime/src/proxy/index.ts:568-582`, `runtime/src/proxy/routes/messages.ts:397-400`).

## 4. Multi-provider router

The inbound surface is Anthropic-shaped for every provider (ADR-0019).
Routing order is an explicit `provider/` prefix, then a model-name heuristic,
then `CQ_DEFAULT_PROVIDER` (default `anthropic`)
(`runtime/src/proxy/providers/router.ts:61-68`). `claude*` goes to Anthropic;
`gpt*`, `o<digit>*` and similar go to OpenAI; `gemini*` goes to Gemini
(`runtime/src/proxy/providers/router.ts:46-52`). Credentials come from env per
provider (`runtime/src/proxy/providers/router.ts:77-114`). OpenAI, OpenRouter
and local servers share one OpenAI-compatible adapter; Gemini has its own
(`runtime/src/proxy/providers/router.ts:122-128`). An unconfigured provider
returns an Anthropic-shaped 400 (`runtime/src/proxy/providers/router.ts:144-155`).
Both forward paths are wrapped in retry and backoff
(`runtime/src/proxy/default-deps.ts:44-45`). In the proxy's own environment `ANTHROPIC_BASE_URL` is the upstream, default
`https://api.anthropic.com` (`runtime/src/proxy/providers/router.ts:81-82`).

## 5. Memory

`runtime/docs/MEMORY_ARCHITECTURE.md` is the design. It describes a pipeline
where turns evicted from a 2-hour RAM window are extracted into facts. That
pipeline exists as a library (`runtime/src/memory/manager.ts:1-19`), but no
proxy route or script calls `createMemoryManager`. The flow below is what runs.

```mermaid
flowchart LR
  EX["Completed exchange (commercial, extraction enabled)"] --> LX["Local model extractor (loopback only)"]
  LX --> VAL["Zod validation, invalid facts dropped"]
  VAL --> AUD{"Audit repo configured?"}
  AUD -- "no" --> T2["Tier-2 fact tables (visible)"]
  AUD -- "yes" --> T2S["Tier-2 insert, suppressed"]
  T2S --> AT["Git attestation"]
  AT -- "not CONFLICT" --> REL["Release: is_suppressed = false"]
  AT -- "CONFLICT" --> KEEP["Stays suppressed, audit result stored"]
  REL --> T2
  T2 --> PR["promote-tier2-to-tier3 script (manual or launchd)"]
  PR --> KG["Tier-3 graph: knowledge_entities / edges"]
  PR --> VEC["Tier-3 pgvector: embedding + source pointer"]
  T2 --> API["/v1/memory/* routes"]
  T2 --> SS["SessionStart bridge script"]
  VEC --> SS
```

**Tier 1, hot.** `createHotMemory` holds verbatim turns and their embeddings
in RAM for a rolling window, default 2 hours (`runtime/src/memory/hot/tier1.ts:1-14`,
`runtime/src/memory/hot/tier1.ts:32-33`). The only production user is the
shadow observer. It keeps one window per conversation, at most 100
conversations and 128 turns each, and drops a window after 2 hours idle
(`runtime/src/proxy/shadow-observer.ts:77-79`).

**Tier 2, warm.** Typed facts go to one table per fact type:
`function_changes`, `tech_decisions`, `policy_updates`, `todos`,
`variable_changes`, `operational_references` (`runtime/src/memory/warm/tier2.ts:32-38`). The caller
supplies `org_id` and `session_id`; values on the fact are never trusted
(`runtime/src/memory/warm/tier2.ts:9-16`). Facts are validated on write and on
read, and suppressed rows are not returned (`runtime/src/memory/warm/tier2.ts:17-18`,
`runtime/src/memory/warm/tier2.ts:201`).

In the proxy, extraction runs only when `CQ_MEMORY_EXTRACT_MODEL` is set to a
`local/<model>` id and `CQ_LOCAL_BASE_URL` is an HTTP loopback address
(`runtime/src/proxy/index.ts:112-119`, `runtime/src/proxy/index.ts:456-464`).
The recorder writes facts under the verified conversation, or a new memory
session (`runtime/src/proxy/message-memory.ts:22-31`). Extracted facts are
never summaries (ADR-0004, `runtime/src/memory/warm/extractor.ts:1-7`).

**Tier 3, cold.** Tier 3 runs on Postgres, not Neo4j and Pinecone (ADR-0013).
The graph uses `knowledge_entities` and `knowledge_edges` with a
`find_superseded` SQL function (`runtime/src/memory/cold/graph.ts:1-16`).
The vector store uses pgvector through the `match_memory_vectors` RPC
(`runtime/src/memory/cold/vectors.ts:107`). It stores only 384-d embeddings
and a pointer to the source row, never plaintext
(`runtime/src/memory/cold/vectors.ts:8-14`). `runtime/src/memory/cold/pinecone.ts`
and `runtime/src/memory/cold/neo4j.ts` are TODO stubs.

**Promotion.** `npm run promote` copies unpromoted Tier-2 facts older than
`PROMOTE_OLDER_THAN_DAYS` (default 30) into the Tier-3 graph and vector store
(`runtime/scripts/promote-tier2-to-tier3.ts:1-20`, `runtime/scripts/promote-tier2-to-tier3.ts:52-54`).
The Tier-2 rows stay in place. Each one is set to `promoted_to_t3 = true` and
is never deleted, so a promoted fact exists in both tiers
(`runtime/scripts/promote-tier2-to-tier3.ts:19-20`, `runtime/src/memory/warm/tier2.ts:286`).
`npm run promote:schedule` installs a macOS launchd job for it
(`runtime/package.json:40-41`, `runtime/scripts/local-promotion-schedule.ts:1`).

**Recall.** Facts are read through `/v1/memory/*`
(`runtime/src/proxy/routes/memory.ts:1-15`) and through the Claude Code
SessionStart bridge, which returns up to three recent and three semantic facts
(`runtime/scripts/session-start-context.ts:1`, `runtime/scripts/session-start-context.ts:14-15`).
No fact is injected into a proxied request.

## 6. Pruner (shadow only)

The pruner computes cosine similarity of stored turn embeddings against the
query, applies temporal decay, and selects spans with KadaneDial
(`runtime/src/pruner/pruner.ts:1-15`, `runtime/src/pruner/kadanedial.ts:1-8`).
The encoder is all-MiniLM-L6-v2 via ONNX, 384 dimensions, run locally
(`runtime/src/pruner/encoder.ts:1-18`). Supersession suppression drops a
selected turn whose entity is superseded by another selected entity; it is
default-off (`runtime/src/pruner/supersession.ts:1-17`). The pruner is not in
the request path and pruning is enabled nowhere
(`runtime/src/pruner/pruner.ts:10-14`). The code header and ADR-0014 report the
LoCoMo gate as red at the documented decay setting (`runtime/src/pruner/kadanedial.ts:10-24`).

The only live caller is the shadow observer, enabled by `CQ_SHADOW_OBSERVE`
in commercial mode (`runtime/src/proxy/index.ts:423-440`). It runs selection
on its own window and logs counts: candidates, selected, pruned, fact
coverage, and superseded candidates (`runtime/src/proxy/shadow-observer.ts:190-203`).
It never changes forwarding or billing (`runtime/src/proxy/forward.ts:98`).
`runtime/src/pruner/crypto.ts` is not part of pruning. It holds the offline
AES-256-GCM primitive of ADR-0022, and no request path calls it
(`runtime/src/pruner/crypto.ts:1-12`).

## 7. Audit engine

Tier 1 of the audit is deterministic and needs no LLM. `git-indexer.ts` turns
`git log -z -p` output into code changes (`runtime/src/audit/git-indexer.ts:1-12`).
`git-attestation.ts` checks each fact against them and returns `CONFIRMED`,
`UNVERIFIED` or `CONFLICT` (`runtime/src/audit/git-attestation.ts:1-9`).
`audit-engine.ts` composes both and stores results through the
`persist_audit_results` RPC (`runtime/src/audit/audit-engine.ts:32`,
`runtime/src/audit/audit-engine.ts:82`, `runtime/src/audit/audit-engine.ts:106`).

In the proxy, the audit runs only when `CQ_AUDIT_REPO_ROOT` is set, which also
requires local extraction (`runtime/src/proxy/index.ts:393-395`). The repo path
must stay inside the project root and contain no symlinks
(`runtime/src/proxy/index.ts:97-110`). Facts are inserted suppressed and released
unless the result is `CONFLICT` (`runtime/src/proxy/message-memory.ts:34-48`).

Tier 2 (Llama spot-check) and Tier 3 (Opus escalation) have prompt-building and
parsing code but are wired nowhere in the request path
(`runtime/src/audit/llama-check.ts:9-13`, `runtime/src/audit/opus-escalation.ts:9-12`).

## 8. Usage persistence and remaining payment code

**Usage outbox.** Team mode journals each successful request's usage in a local
directory, default `data/usage-outbox`, before successful response completion.
The directory must be private (0700), writable and inside the project root;
event files are private (0600). A temporary file is written, fsynced and
renamed, then the directory is fsynced. Replay runs on startup and every 10 s
by default. A file is removed and the directory fsynced only after the database
confirms persistence or a verified duplicate. Failures retain the event and
log an error. The format stays compatible with pre-C2 queued inputs
(`runtime/src/usage/durable-usage-outbox.ts`). A journal failure retains the
client-visible `billing_unavailable` error; database latency stays off the
successful response path after journaling.

**Records.** The unsigned writer inserts one `billing_records` row per event.
Its inputs are organization, usage session, original/quarantined token counts,
pinned estimated price, optional pruning log and usage event ID. Daily usage
sessions are scoped by organization, UTC occurrence day, model and authenticated
project. Original time and price survive replay. Without active pruning,
quarantined tokens equal original tokens and estimated savings are zero
(`runtime/src/usage/usage-recorder.ts`, `runtime/src/usage/pricing.ts`).

On an event-ID uniqueness conflict, the writer reads the stored row and checks
its nonempty ID, organization, session, token counts, event ID, optional pruning
log and pinned price. Price comparison respects the database's `NUMERIC(12,8)`
precision. A mismatch or missing result is an error, never acknowledgement
(`runtime/src/usage/recorder.ts`).

**Schema boundary.** C2 migration M1 removes the three mutation-blocking
triggers, their function, `cq_fee_usd` and `signed_hash`, in that order. RLS,
foreign keys, the unique usage-event index, and generated `token_delta` and
`cost_delta_usd` remain. Usage rows are mutable and no HMAC is calculated.
Stop the old proxy while preserving its outbox, apply M1, then run the C2
writer. Neither writer is compatible with the other schema; deliver this
writer and migration together
(`runtime/supabase/migrations/20261003000000_unsigned_usage_ledger.sql`).

**Legacy invoices.** C1 removed payment HTTP routes. The invoice engine,
Stripe library and operator scripts remain under `runtime/src/billing/` until
C3. Invoice and signature verification commands expect the retired columns and
cannot process the post-M1 schema. Invoice tables and the existing erasure
retention blocker remain until C4. DevOps has no payment workflow.

**Usage reads.** `runtime/src/proxy/routes/usage.ts` serves
`GET /v1/billing/summary` and `GET /v1/billing/records` with token totals and
estimated USD cost differences. Its summary uses `runtime/src/usage/summary.ts`
and reads every row in stable ID order with an exact count. A project-bound
key receives 403. The session stats also expose only counts and estimated USD
savings. None of these readers imports a billing module.

**What is local-only.** The outbox lives on the proxy's disk and the usage
and remaining invoice tables in the local Compose database. This document records
no Stripe send and no paid invoice. Commercial startup refuses to run when the `VERCEL`
environment variable is set to a value other than `0`
(`runtime/src/proxy/index.ts`, `assertCommercialStartup` and
`buildStartOptions`). That is
the only host check. On any other host with an ephemeral disk, commercial startup proceeds
and the outbox is not durable.

## 9. HTML surfaces

| Path | Source | Data |
|---|---|---|
| `/dashboard` | inline `HTML` in `runtime/src/proxy/routes/dashboard.ts:45` | `/dashboard/api`: totals, sessions and waste from local capture files (`runtime/src/proxy/dashboard-data.ts:1-7`) |
| `/dashboard/graph` | `runtime/src/proxy/routes/graph-dashboard.ts:1-2` | the `/v1/memory/graph*` routes, with an API key |
| `/docs`, `/openapi.json` | `runtime/src/proxy/openapi.ts` | static API spec (`runtime/src/proxy/app.ts:385-396`) |

`/dashboard/api` returns 403 when auth is enforced, because capture files
carry no tenant key (`runtime/src/proxy/routes/dashboard.ts:213-217`). The
dashboard's dollar figure is an estimate at fixed Opus-class rates
(`runtime/src/proxy/dashboard-data.ts:19-20`). `runtime/src/dashboard/index.html`
is an unused placeholder page. The two dashboard HTML routes send a strict
CSP and `X-Frame-Options: DENY`
(`runtime/src/proxy/routes/dashboard.ts:193-210`).

## 10. Local Compose storage

The Supabase adapters talk to a local stack defined in
`runtime/supabase/docker-compose.local.yml`: Postgres, PostgREST and a Kong
gateway (`runtime/supabase/docker-compose.local.yml:4-34`). Only the gateway
publishes a port, on `127.0.0.1:54321` (`runtime/supabase/docker-compose.local.yml:37`).
`npm run db:start` starts the containers, checks the real Docker bindings, and
applies pending migrations in filename order (`runtime/docs/LOCAL_STORAGE.md:9-23`,
`runtime/scripts/local-compose.ts:29-30`, `runtime/scripts/local-compose.ts:111-117`). The schema is the ordered history in
`runtime/supabase/migrations/`. The database uses trust auth inside its Docker
network, so the stack is for development only (`runtime/docs/LOCAL_STORAGE.md:31-33`,
ADR-0020). The operator owns backups. A production storage plan is open.

`npm run backup` exports one org's rows to a JSON file, and `npm run restore`
re-inserts such a file into a clean target (`runtime/package.json:47-48`,
`runtime/scripts/backup-org.ts:1-14`, `runtime/scripts/restore-org.ts:1-13`).
The export covers a fixed table list (`runtime/scripts/backup-org.ts:22-43`).
The export includes `billing_records`, `invoices` and `invoice_send_claims`;
the invoice tables stay in backups until C4 drops them. Restore strips and
reports retired fee/signature columns from old usage rows, and strips the
surviving generated columns for database recomputation. It keeps all other
inputs and identifiers. Events waiting in the on-disk outbox are files rather
than table rows and are outside this export. Preserve that directory separately
when backing up or upgrading (`runtime/scripts/backup-org.ts`,
`runtime/scripts/restore-org.ts`, `runtime/src/usage/durable-usage-outbox.ts`).

## 11. ADR index

Status text is copied from each file's status line.

| ADR | Title | Status line | Notes |
|---|---|---|---|
| 0001 | Use Supabase (Postgres) Instead of SQLite | Accepted | Hosted choice superseded by 0020 |
| 0002 | Time-Based Decay (Hours) Instead of Turn-Count Decay | Accepted | See 0015 |
| 0003 | Hybrid-Local Pruning for ZK-Context | Accepted | Pruning not active |
| 0004 | Prohibit LLM Summarization for Memory Compression | Accepted | |
| 0005 | Cloudflare Workers Over Traditional Node.js Server | Accepted | Fastify is the running entry; Worker unverified |
| 0006 | Dual Cold Storage — Pinecone (Vector) + Neo4j (Graph) | Accepted | Implemented on Postgres per 0013 |
| 0007 | Llama 4-8B for Fact Extraction (Not Claude Opus) | Accepted | Proxy requires a local model |
| 0008 | Anthropic SDK version pin (Session 15 §2a-3) | Accepted — 2026-05-28 | |
| 0009 | v0.4.x Pruner Core — Implementation Decisions | Accepted | |
| 0010 | transformers.js for the ONNX Bi-Encoder | Accepted | |
| 0011 | v0.4.x Pruner Over-Retention — Finding & Supersession-Fix Design | Proposed (design only; implementation + activation gated on Tier-A validation) | |
| 0012 | Tier-2 Warm-Memory Persistence Adapter | Accepted (implemented; live schema applied to the Stratum Supabase project + round-trip verified) | Hosted project now retired |
| 0013 | Tier-3 Cold Memory on Supabase (deviation from Neo4j + Pinecone) | Accepted (user-approved 2026-05-29 — explicit deviation from the locked blueprint) | |
| 0014 | Tier-A LoCoMo Integration, the λ-Horizon Finding, and Evidence-Survival Co-Gating | Accepted (the gate is wired + run; pruning stays OUT of the request path — RED, correctly) | |
| 0015 | Temporal Decay is Tier/Workload-Aware — Scale-Invariant Decay Option (default-OFF) | Accepted (mechanism built default-OFF; activation as a default is Tier-A-gated — see ADR-0014/0009) | |
| 0016 | The Eval Gate is Degradation-Dominant; Absolute Floors are Pruning-Attributable Only | Accepted — PB-43 (degradation-dominant metrics) AND PB-39 (evidence-survival co-gate) both implemented + tested (2026-05-29) | |
| 0017 | v0.6.x Git-Attestation Audit Engine — Storage-Decoupled Deterministic Core, Built Ahead of Gate | Accepted (Tier-1 runs free + adversarially hardened; Tier-2/3 real runs + request-path activation are gated) | |
| 0018 | The Upstream Anthropic Key in Commercial Mode — Per-Deployment for the Pilot, Per-Request Pass-Through to Scale | Accepted (per-deployment key for the first design partner; per-request pass-through is the documented scale path, default-OFF until taken up) | |
| 0019 | Multi-Provider Gateway — Anthropic-Shaped Surface, Provider Adapters Behind It | Accepted (Anthropic-in / any-provider-out; an OpenAI-compatible INBOUND surface is a documented, additive follow-on) | |
| 0020 | Local Supabase stack after hosted project retirement | Accepted for local development; production topology open | |
| 0021 | Session erasure needs a separate financial retention boundary | Proposed; technical inventory complete, policy and implementation open | |
| 0022 | Versioned client encryption primitive before TEE integration | accepted for offline implementation; request-path activation is gated. | |
| 0023 | Provenance-gated exchange selection, and what Tier-C gates | proposed (2026-09-25). The owner delegated these decisions to the orchestrator's recommendation and may override any of them. | |
| 0024 | Tier-2 long-history recall assembly (option A), gated | proposed (2026-09-25). The owner delegated this to the orchestrator's recommendation and may override it. | |

Sources: `runtime/docs/decisions/0001-*.md` through `0024-*.md`, line 1 (title)
and lines 3-5 (status).
