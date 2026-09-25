# Stratum telemetry

This page lists what the Stratum proxy emits, where each item goes, and what
leaves the machine. It answers `plan.md` §7 "Telemetry policy + opt-out"
(`plan.md:414`). It describes the code in this checkout. It does not describe a
deployment: no statement here means that a Stratum instance is running anywhere.

All paths are relative to the repository root. The proxy entry points are
`stratum/src/proxy/index.ts` (Node server) and `stratum/vercel-src/entry.ts`
(serverless function). Both build the app with the same `buildProxy` and
`buildStartOptions` calls (`stratum/vercel-src/entry.ts:45`,
`stratum/src/proxy/index.ts:247`), but they pass different environment values
and dashboard directories. Commercial mode does not start on the serverless
entry by default (see "Commercial mode only" below).

## Summary

| Item | When | Where it goes | Leaves the machine? |
|---|---|---|---|
| Proxied provider request | Every `POST /v1/messages` | The selected provider's API | Yes, unless the provider is a local model |
| Anthropic token-count request | Anthropic-routed turns when `ANTHROPIC_API_KEY` is set | Anthropic `count_tokens` endpoint | Yes |
| `stratum.turn` record | Every turn that reaches the capture step | Process standard output (pino) | No, unless the operator ships stdout elsewhere |
| Other log lines | Startup, errors, shadow observation | Process stdout / stderr | Same as above |
| Capture artifact | Every turn that reaches the capture step | `session-<uuid>.json` on local disk | No |
| Usage outbox files | Commercial mode (always on; startup requires the billing signing secret) | `data/usage-outbox/` on local disk | No |
| Database rows and lookups | Commercial mode only | The Supabase API at `SUPABASE_URL` | Depends on `SUPABASE_URL` |
| Webhook test delivery | Only when an operator calls `POST /v1/webhooks/test` | The org's configured webhook URL | Yes |

Stratum has no OpenTelemetry exporter, no Sentry, and no analytics or
"phone home" call. Details and sources follow.

## The per-turn `stratum.turn` record

For each proxied turn the message route calls `emitTurnTelemetry` once, on the
non-streaming path and on the streaming path.

The record has exactly these fields:

| Field | Meaning |
|---|---|
| `stratum.session_id` | The capture session id: a random UUID created once per process start |
| `stratum.turn_number` | Turn counter within that capture session |
| `stratum.model` | The `model` string from the request body |
| `stratum.input_tokens` | Upstream-reported input tokens; the pre-flight count if upstream omitted it |
| `stratum.output_tokens` | Upstream-reported output tokens (0 if absent) |
| `stratum.token_count_method` | `exact` or `estimated` |
| `stratum.elapsed_ms` | Wall time for the turn in the proxy |
| `stratum.streaming` | `true` for SSE turns |
| `stratum.dropped` | `true` when the capture store dropped the turn because redaction failed |

The record carries no message or response content, no API key, and no org or
user id.

Where it goes: the default sink calls `logger.info(attrs, "stratum.turn")`.
The logger is a plain pino instance with no destination argument, so pino
writes one JSON line to standard output. Pino adds its standard fields
(`level`, `time`, `pid`, `hostname`, `msg`). Checked with the installed pino:
`pino({level:"info"}).info({...}, "stratum.turn")` printed
`{"level":30,"time":…,"pid":…,"hostname":…,…,"msg":"stratum.turn"}` on stdout. With `NODE_ENV=development` the
line goes through `pino-pretty` instead. `resolveTelemetrySink` returns this
log sink unless `STRATUM_TELEMETRY_OPT_OUT` is set (see "Opt-out" below); no
OTLP or other network sink exists. A sink error is caught and logged as a warning;
it never fails the request.

The record is an `info`-level line. If `LOG_LEVEL` is set to `warn` or higher,
pino does not print it. That is a side effect of the log level, not the
opt-out described below.

Turns that are not recorded: a request that fails validation (400), a
commercial-mode token-budget rejection or conversation-resolve failure, an
upstream network failure (502), and an upstream 4xx/5xx response all return
before capture and telemetry. This holds on both paths. On the streaming path,
an upstream response with status 400 or higher, or with no stream, is sent back
before the stream is opened.

Sources:
- `stratum/src/proxy/telemetry.ts:19-30` (fields), `stratum/src/proxy/telemetry.ts:38-41` (default sink), `resolveTelemetrySink` and `emitTurnTelemetry` in `stratum/src/proxy/telemetry.ts`
- `stratum/src/proxy/routes/messages.ts:351-364` (streaming emission), `stratum/src/proxy/routes/messages.ts:463-476` (non-streaming emission)
- `stratum/src/proxy/routes/messages.ts:405-448` (non-streaming early returns without capture or telemetry, including `:428-430` for the commercial gates), `stratum/src/proxy/routes/messages.ts:259-275` (streaming early returns, including `:273-275` for an upstream status >= 400 or a missing stream)
- `stratum/src/proxy/default-deps.ts:36` (session id), `stratum/src/proxy/default-deps.ts:54` (sink wiring)
- `stratum/src/lib/logger.ts:15-18` (logger, `LOG_LEVEL`, `pino-pretty` in development)
- `stratum/node_modules/pino/pino.js:210` (installed pino: default destination is `process.stdout.fd`)

## Other log output

The proxy writes these other lines. All go to the local process output.

- Fastify request logging is off (`logger: false`), so there is no per-request
  access log. `request.log` calls in the routes print nothing.
- Unhandled route errors: `logger.error({ err, status }, "proxy error")`. The
  `err` field is the error message, which can include a database error text.
- Startup: port, host, and mode. Shutdown: signal name.
- Commercial mode: plan-lookup failures (with `orgId`) and usage-outbox replay
  failures (with the event id).
- Commercial mode with `CQ_SHADOW_OBSERVE=true`: one
  `"shadow conversation selection"` info line, at most one per observed turn. It
  holds `conversationId`, `orgId`, `keyId`, an optional project scope id, and
  counts. It holds no message content.
- Capture-store errors go to standard error through `console.error`: a
  `[PII-redaction FAIL-CLOSED]` line when a turn is dropped, and a
  `[capture flush error]` line when the file write fails. These lines hold the
  turn number and the error name and message, not turn content.

Sources:
- `stratum/src/proxy/app.ts:121` (Fastify logger off), `stratum/src/proxy/app.ts:228` (proxy error)
- `stratum/src/proxy/index.ts:253`, `stratum/src/proxy/index.ts:271` (shutdown, startup)
- `stratum/src/proxy/index.ts:159`, `stratum/src/proxy/index.ts:201` (plan lookup, outbox replay)
- `stratum/src/proxy/index.ts:171-177`, `stratum/src/proxy/shadow-observer.ts:19-37`, `stratum/src/proxy/shadow-observer.ts:190`, `stratum/src/proxy/routes/messages.ts:379`, `stratum/src/proxy/routes/messages.ts:482` (shadow line, its fields, one emit per observed turn)
- `stratum/src/proxy/capture.ts:112`, `stratum/src/proxy/capture.ts:150`, `stratum/src/proxy/capture.ts:187` (capture errors)

## The capture artifact

Turns are written to a local JSON file, in personal and in commercial mode:
every non-streaming 2xx turn, and every streaming turn once the stream opens
(including a stream that ends in an upstream error or a client abort).

- Path: `$CQ_CAPTURE_DIR/session-<uuid>.json`, default
  `<cwd>/data/sessions/session-<uuid>.json`. One file per process start. The
  path is gitignored.
- The proxy does not create the directory. If it is missing, the write fails,
  a `[capture flush error]` line goes to stderr, and the turn stays in memory
  only.
- The file is rewritten in full after every recorded turn. No file mode is
  set, so the process umask applies. The store also has an `end()` function
  that sets `ended_at` and rewrites the file, but no code in `stratum/src` or
  `stratum/vercel-src` calls it. There is no session-end write, and `ended_at`
  is never set. The shutdown path closes Fastify; the only `onClose` hook in
  the message route waits for pending writes and closes the usage outbox. It
  does not touch the capture store, although the shutdown log line and a code
  comment in `index.ts` say captures are flushed.
- Stored per turn: the request `model`, `messages`, `system`, `tools` and
  `max_tokens`, after redaction; the input token count and its method; a
  `message_breakdown` field; the response `id`, `usage` and `stop_reason` only;
  and the elapsed time. The response text is not stored. No production counter
  fills `message_breakdown`: the exact path, the estimate paths and the route
  fallbacks all return an empty array, so the stored value is always `[]`.
- Redaction uses the shared redactor in `observability/pii-redaction.ts`.
  It covers emails, phone numbers, SSNs, card numbers, JWTs, OAuth tokens and
  key:value secret patterns. Prompt text outside those patterns is stored as
  written. If the redactor throws, the turn is dropped and not written.
- The personal-mode dashboard (`/dashboard`) reads session files from a
  directory and serves a summary over the proxy's own HTTP port. The two
  entries choose that directory differently, and in each case it can differ
  from the directory the capture store writes to:
  - Node server: the dashboard always reads `<cwd>/data/sessions` and ignores
    `CQ_CAPTURE_DIR`. If `CQ_CAPTURE_DIR` is set to another directory, the
    capture files go there and the dashboard does not show them.
  - Serverless entry: the dashboard reads `CQ_CAPTURE_DIR` or `/tmp`, while the
    capture store uses `CQ_CAPTURE_DIR` or `<cwd>/data/sessions`. Set
    `CQ_CAPTURE_DIR` there so both agree.

Sources:
- `stratum/src/proxy/default-deps.ts:37-40`, `stratum/src/proxy/default-deps.ts:53` (path, wiring)
- `stratum/.gitignore:47` (`data/sessions/`)
- `stratum/src/proxy/capture.ts:125-127` (full rewrite, no mode), `stratum/src/proxy/capture.ts:136-153` (redact or drop), `stratum/src/proxy/capture.ts:156-171` (stored fields), `stratum/src/proxy/capture.ts:183-188` (flush error handling)
- `stratum/src/proxy/capture.ts:192-202` (`end()` sets `ended_at`; no caller in `stratum/src` or `stratum/vercel-src`), `stratum/src/proxy/routes/messages.ts:397-400` (the only `onClose` hook), `stratum/src/proxy/index.ts:253-257` (shutdown log and comment)
- `stratum/src/proxy/token-count.ts:76`, `stratum/src/proxy/token-count.ts:82`, `stratum/src/proxy/providers/router.ts:194`, `stratum/src/proxy/routes/messages.ts:169-173`, `stratum/src/proxy/routes/messages.ts:424` (every `message_breakdown` producer returns `[]`)
- `observability/pii-redaction.ts:8-9` (coverage), `stratum/src/proxy/capture.ts:16` (import)
- `stratum/src/proxy/routes/messages.ts:336-350` (streaming turns are captured in `finally`, including on client abort)
- `stratum/src/proxy/index.ts:226`, `stratum/src/proxy/index.ts:245` (Node dashboard reader: fixed `<cwd>/data/sessions`), `stratum/src/proxy/default-deps.ts:39` (capture store directory)
- `stratum/vercel-src/entry.ts:38`, `stratum/vercel-src/entry.ts:42` (serverless dashboard directory)

## OpenTelemetry and Sentry

- No OpenTelemetry exporter is wired. `resolveTelemetrySink` never returns an
  OTLP sink; the OTLP path is a comment that marks where one would go.
  No runtime code reads `OTEL_EXPORTER_OTLP_ENDPOINT`; it appears in
  `stratum/src` only in comments, and only the test setup and two tests set or
  read it. No `@opentelemetry/*` package is a Stratum
  dependency. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` changes nothing.
- The repository has an OTel span-exporter wrapper at
  `observability/otel-exporter.ts`. Stratum's `src/` does not import it.
- Sentry does not exist in Stratum: no dependency, no import, no reference in
  `src/`.

Sources:
- `resolveTelemetrySink` in `stratum/src/proxy/telemetry.ts` (OTLP comment only)
- `stratum/src/proxy/telemetry.ts:8`, `stratum/src/proxy/telemetry.ts:55` (comments only)
- `stratum/test/setup.ts:15`, `stratum/test/capture-session/config-resolution.test.ts:38-40`, `stratum/test/capture-session/otel-soft-dep.test.ts:30`, `stratum/test/capture-session/otel-soft-dep.test.ts:53-67` (the only code that sets or reads `OTEL_EXPORTER_OTLP_ENDPOINT`; all tests)
- `stratum/package.json:87-119` (dependencies: no `@opentelemetry/*`, no `@sentry/*`)
- `observability/otel-exporter.ts:1-15`

## What leaves the machine

### 1. The proxied provider request

This is the purpose of the proxy. The full request body goes to the provider
selected from the model name: messages, system prompt, tools and parameters.

| Provider | Default base URL | Override |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | `ANTHROPIC_BASE_URL` in the proxy's environment |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_BASE_URL` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_BASE_URL` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_BASE_URL` |
| Local | none | `CQ_LOCAL_BASE_URL` |

From the client's headers, only `anthropic-version` and `anthropic-beta` are
passed through. The provider API key comes from the proxy's environment.
For OpenRouter, `OPENROUTER_REFERER` and `OPENROUTER_TITLE` are sent as
`HTTP-Referer` and `X-Title` when set. With a local provider the request stays
on whatever host `CQ_LOCAL_BASE_URL` names.

Sources: `stratum/src/proxy/providers/router.ts:77-110`, `stratum/src/proxy/routes/messages.ts:147-155`, `stratum/src/proxy/routes/messages.ts:436`.

### 2. The Anthropic token-count request

Before forwarding an Anthropic-routed turn, the proxy asks Anthropic for an
exact input-token count. This is a second request to Anthropic that carries
the same `model`, `messages`, `system` and `tools`. It happens only when
`ANTHROPIC_API_KEY` is set. The Anthropic SDK sends it to `ANTHROPIC_BASE_URL`
if set, else `https://api.anthropic.com`. Results are kept in an in-memory
cache of 256 entries, so an identical body is not counted twice. Other
providers get a local estimate and no network call. In commercial mode,
`POST /v1/tokens/count` uses the same counter.

Sources: `stratum/src/proxy/default-deps.ts:33-34`, `stratum/src/proxy/default-deps.ts:46`, `stratum/src/proxy/providers/router.ts:192-194`, `stratum/src/proxy/providers/router.ts:207-213`, `stratum/src/proxy/token-count.ts:54`, `stratum/src/proxy/token-count.ts:70-75`, `stratum/src/proxy/index.ts:190`, `stratum/node_modules/@anthropic-ai/sdk/client.js:67`, `stratum/node_modules/@anthropic-ai/sdk/client.js:87`.

### 3. Commercial mode only

Commercial mode is on when `CQ_COMMERCIAL` is `true` or `1` and
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set. With `CQ_COMMERCIAL` on,
startup also refuses to run unless `CQ_BILLING_SIGNING_SECRET` is set, and
refuses when `VERCEL` is set to a value other than `0`. So every running
commercial proxy writes the usage outbox and `billing_records`. The serverless
entry sets `VERCEL` to `1` when it is unset, so commercial mode fails at
startup there unless the environment sets `VERCEL=0`. Personal mode makes none
of these calls.

- **Supabase API.** The proxy reads and writes the database through the
  Supabase HTTP API at `SUPABASE_URL`. The hosted Supabase project is retired;
  development uses the local Compose stack, whose gateway listens on
  `127.0.0.1:54321`. Whether this traffic leaves the machine depends only on
  `SUPABASE_URL`. See "Database records" below for what is written.
- **Webhook test delivery.** `POST /v1/webhooks/test` sends a signed sample
  event to the org's configured webhook URL. It runs only when an operator
  calls that endpoint. No other code path in the proxy delivers webhooks.
- **Stripe.** The proxy receives Stripe events at `POST /stripe/webhook`
  when `STRIPE_WEBHOOK_SECRET` is set. It makes no outbound Stripe call.
  Calls to `https://api.stripe.com` happen only from the operator scripts
  `scripts/invoice.ts` and `scripts/verify-stripe.ts`.
- **Memory extraction model.** With `CQ_MEMORY_EXTRACT_MODEL`, turns go to a
  local model for fact extraction. Startup rejects any endpoint that is not
  plain HTTP on `127.0.0.1`, `localhost` or `[::1]`.
- **Shadow observer.** With `CQ_SHADOW_OBSERVE=true`, the ONNX encoder runs
  with remote model downloads disabled. The observer also sends message
  content to the database: for an observed turn, it passes the first 1,200
  characters of the text of the latest user message as the `search_text`
  argument of the `find_query_hot_fact_exchanges` RPC at `SUPABASE_URL`. The
  RPC is a read-only SQL function that matches that text against stored facts;
  it does not store the text. The call is skipped when there are no hot
  exchange ids for the conversation or when a prior exchange failed to
  persist.

Sources:
- `stratum/src/proxy/index.ts:110-113` (commercial mode), `stratum/src/proxy/index.ts:116-121` (startup requirements), `stratum/src/proxy/index.ts:242`, `stratum/vercel-src/entry.ts:33-35` (checked at startup on both entries; serverless `VERCEL` default), `stratum/src/proxy/index.ts:141-147` (Supabase client)
- `stratum/docs/decisions/0020-local-storage-after-hosted-retirement.md`, `stratum/docs/LOCAL_STORAGE.md` (local stack, `127.0.0.1:54321`)
- `stratum/src/proxy/routes/webhooks.ts:53`, `stratum/src/proxy/routes/webhooks.ts:87`, `stratum/src/webhooks/deliver.ts:81`
- `stratum/src/proxy/index.ts:166-168`, `stratum/src/proxy/routes/stripe-webhook.ts:56`, `stratum/src/billing/stripe.ts:45`, `stratum/src/billing/stripe.ts:55`, `stratum/scripts/invoice.ts:18-20`, `stratum/scripts/verify-stripe.ts:19`
- `stratum/src/proxy/index.ts:87-94`, `stratum/src/proxy/index.ts:204-212` (loopback-only extraction)
- `stratum/src/proxy/index.ts:172`, `stratum/src/pruner/encoder.ts:99` (`allowRemoteModels = false`)
- `stratum/src/proxy/routes/messages.ts:117-118` (query is the latest user message text), `stratum/src/proxy/shadow-observer.ts:104`, `stratum/src/proxy/shadow-observer.ts:153-154` (truncate to 1,200 characters and send), `stratum/src/memory/warm/query-fact-exchanges.ts:9-16` (RPC call with `search_text`), `stratum/src/proxy/index.ts:180` (wiring), `stratum/supabase/migrations/20260924235800_shadow_hot_query_lookup.sql:3-8` (read-only `STABLE` SQL function)

### Not outbound

- The dashboard pages call `fetch('/dashboard/api')` and similar relative
  URLs from the browser. Those requests go to the proxy itself.
- `@pinecone-database/pinecone` and `neo4j-driver` are listed dependencies,
  but no file under `stratum/src/` imports them.
- The Cloudflare Worker variant (`src/proxy/worker.ts`) only serves
  `GET /health` and forwards `POST /v1/messages`. It has no telemetry sink, capture store or logger. Its
  runtime is not verified.

Sources: `stratum/src/proxy/routes/dashboard.ts:89`, `stratum/src/proxy/routes/graph-dashboard.ts:125-126`, `stratum/package.json:92`, `stratum/package.json:98`, `stratum/src/proxy/worker-core.ts:1-11`, `stratum/src/proxy/worker-core.ts:17-20`.

## What stays local

- The `stratum.turn` records and all other log lines, on the process's
  standard output and standard error. Stratum does not send them anywhere. A
  host that collects process output (for example a serverless platform's log
  service) receives them; that is the host's behavior, not Stratum's.
- The capture artifacts in `data/sessions/` (or `CQ_CAPTURE_DIR`).
- In commercial mode (which requires `CQ_BILLING_SIGNING_SECRET`), the usage outbox: one
  `<eventId>.json` file per billed response in `data/usage-outbox/` (or
  `CQ_USAGE_OUTBOX_DIR`). The directory is mode `0700` and each file `0600`.
  A file holds `orgId`, optional project scope id, `eventId`, `occurredAt`,
  `model`, `inputTokens`, `outputTokens` and the pinned price. It is deleted
  after the row reaches the database.

Sources: `stratum/src/proxy/index.ts:195-202`, `stratum/src/proxy/routes/messages.ts:219-241`, `stratum/src/billing/durable-usage-outbox.ts:66-68`, `stratum/src/billing/durable-usage-outbox.ts:121-132`, `stratum/src/billing/durable-usage-outbox.ts:91-92`, `stratum/.gitignore:49`.

## Database records (commercial mode)

These rows are written through the Supabase API at `SUPABASE_URL`. In
development that is the local Compose stack.

- **`billing_records`.** Written on every running commercial proxy, since startup
  requires `CQ_BILLING_SIGNING_SECRET`. One
  append-only row per billed response: `session_id`, `org_id`,
  `original_tokens`, `quarantined_tokens`, `api_price_per_token`,
  `usage_event_id`, `signed_hash`, plus generated cost columns. No content.
  Pruning is not active in requests, so `quarantined_tokens` equals
  `original_tokens` and the savings columns are zero.
- **`sessions`.** Daily usage buckets per org, model and project scope;
  conversation sessions; memory sessions. Ids, model and scope; no content.
- **Facts.** With `CQ_MEMORY_EXTRACT_MODEL`, facts extracted from turns by the
  local model are stored. These are derived from conversation content.
- **Shadow fact lookup (read, not a row).** With `CQ_SHADOW_OBSERVE=true`, up
  to 1,200 characters of the latest user message text are sent to the
  database as an RPC argument. See "Shadow observer" above.
- **`pruning_logs`.** The table exists (turn indices, relevance scores, dial
  parameters; no content). The proxy never writes it. Outside the proxy,
  `scripts/verify-tier2.ts` inserts one throwaway row and deletes it, and
  `scripts/restore-org.ts` re-inserts rows from an org backup.

Sources:
- `stratum/supabase/migrations/20260406000000_initial_schema.sql:65-77` (`pruning_logs`), `stratum/supabase/migrations/20260406000000_initial_schema.sql:83-102` (`billing_records`, append-only rules), `stratum/supabase/migrations/20260924110000_billing_usage_event_identity.sql:4`
- `stratum/src/billing/recorder.ts:102-112` (inserted row), `stratum/src/billing/usage-recorder.ts:95` (usage session), `stratum/src/billing/usage-recorder.ts:140` (no pruning)
- `stratum/src/proxy/conversation.ts:40`, `stratum/src/proxy/message-memory.ts:26`, `stratum/src/proxy/message-memory.ts:32-40`
- `stratum/scripts/verify-tier2.ts:88`, `stratum/scripts/verify-tier2.ts:123`, `stratum/scripts/restore-org.ts:2-6`, `stratum/scripts/restore-org.ts:33`

## Opt-out: `STRATUM_TELEMETRY_OPT_OUT`

```sh
export STRATUM_TELEMETRY_OPT_OUT=true
```

When set to true, the proxy does not emit the per-turn `stratum.turn`
telemetry record.

Set it in the proxy's own environment. It does not change anything else on
this page: the provider request, the token-count request, the capture
artifact, the other log lines and the commercial-mode database writes are
unaffected.

Source: `resolveTelemetrySink` in `stratum/src/proxy/telemetry.ts`.
