# Observability

See `observability/README.md` for the active setup.

## Stack

- OpenTelemetry (industry standard)
- OpenInference semantic conventions (LLM-specific spans)
- Per-tenant baggage (`user.id`, `tenant.id` propagated through call tree)
- Inline PII redaction at exporter

## Backends

| Backend | Best for | Self-host? |
|---------|----------|------------|
| Langfuse | Prompt-centric, evals | yes |
| Laminar | Long-running agents, replay | yes |
| Arize Phoenix | Evaluation-heavy | yes |

## Key invariant

PII never reaches the observability backend. The
`piiRedactingExporter` in `observability/pii-redaction.ts` wraps every exporter.

Required for COPPA / HIPAA / GDPR scope.

## Proxy log lines

The proxy (`runtime/src/proxy`) writes one JSON object per line to stdout through a
single pino instance, `runtime/src/lib/logger.ts`. Nothing in the proxy uses
`console.log`. Pipe the output through `jq` (for example
`... | jq 'select(.level >= 40)'`) or set `NODE_ENV=development` for `pino-pretty`.

### Log levels

The level comes from the `LOG_LEVEL` environment variable and defaults to `info`.
The proxy emits three levels (pino numbers in brackets):

- `info` (30): start-up, drain and shutdown notices, the per-turn `stratum.turn`
  record and the shadow-selection metric.
- `warn` (40): recoverable conditions such as the deprecated `HOST` alias, a remote
  bind, a failed plan lookup (fails open to the starter tier) or a failed sink.
- `error` (50): request errors, shutdown errors, a failed usage replay, a failed
  memory write and fatal process errors.

### Base fields on every line

pino adds `level`, `time` (epoch ms), `pid`, `hostname` and `msg`. `msg` is the
message text in the table below; the other keys are the bound fields.

### Proxy log fields

| Field | Level | Message | Source |
|-------|-------|---------|--------|
| `err` | error, warn | `proxy error`, `memory write failed (non-blocking)`, `usage outbox replay failed`, `error during shutdown`, `Failed to start CQ Proxy`, `getOrgPlan failed ...`, `telemetry sink failed (ignored)` | `runtime/src/proxy/app.ts` |
| `status` | error | `proxy error` | `runtime/src/proxy/app.ts` |
| `orgId` | warn | `getOrgPlan failed ...` | `runtime/src/proxy/index.ts` |
| `eventId` | error | `usage outbox replay failed` | `runtime/src/proxy/index.ts` |
| `deprecated` | warn | `HOST is a deprecated alias ...` | `runtime/src/proxy/index.ts` |
| `use` | warn | `HOST is a deprecated alias ...` | `runtime/src/proxy/index.ts` |
| `host` | warn | the remote-bind warning text | `runtime/src/proxy/index.ts` |
| `signal` | info | `CQ Proxy draining in-flight requests + flushing captures` | `runtime/src/proxy/index.ts` |
| `kind` | error | `fatal process error; closing server and exiting` | `runtime/src/proxy/index.ts` |
| `port` | info | `CQ Proxy running` | `runtime/src/proxy/index.ts` |
| `mode` | info | `CQ Proxy running` | `runtime/src/proxy/index.ts` |
| `stratum.session_id` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.turn_number` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.model` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.input_tokens` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.output_tokens` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.token_count_method` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.elapsed_ms` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.streaming` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `stratum.dropped` | info | `stratum.turn` | `runtime/src/proxy/telemetry.ts` |
| `conversationId` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `keyId` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `projectScopeId` | info | `shadow conversation selection` (optional) | `runtime/src/proxy/shadow-observer.ts` |
| `candidateCount` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `selectedCount` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `prunedCount` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `candidateSupersededExchangeCount` | info | `shadow conversation selection` | `runtime/src/proxy/shadow-observer.ts` |
| `exchangeCompletion` | info | `shadow conversation selection` (optional counts object) | `runtime/src/proxy/shadow-observer.ts` |
| `factCoverage` | info | `shadow conversation selection` (optional counts object) | `runtime/src/proxy/shadow-observer.ts` |
| `queryFactRescue` | info | `shadow conversation selection` (optional counts object) | `runtime/src/proxy/shadow-observer.ts` |
| `provenanceIncompleteExchangeCount` | info | `shadow conversation selection` (optional) | `runtime/src/proxy/shadow-observer.ts` |

Lines with no bound fields also exist: `CQ Proxy shut down cleanly` (info) and
`shadow observation failed` (warn). `orgId` is also a field of the shadow metric.
The `stratum.turn` line is suppressed when `STRATUM_TELEMETRY_OPT_OUT` is `true` or `1`.

### What is redacted

The logger sets no pino `redact` paths and does not run log fields through a
redactor. Log lines stay free of content by construction: they carry ids, counts,
model name, timing and error messages, never prompt or response text
(`runtime/src/proxy/telemetry.ts` states this as a hard rule, and the shadow metric
is counts only). The one caveat is `err`, which is an error's message text; do not
put secrets in thrown messages.

Redaction applies to the capture artifact the proxy writes to disk, not to log
lines. `runtime/src/proxy/capture.ts` runs the request and response through
`redactValue` from `observability/pii-redaction.ts`, which applies `redactString`
to every leaf string. Matches become `[REDACTED:<pattern>]`, strings over
`MAX_REDACT_LEN` become `[REDACTED:oversized-<n>]`, and a redactor error drops the
turn (fail closed), which is what `stratum.dropped` reports.

### Reading the lines

- Follow one turn: filter on `msg == "stratum.turn"` and group by
  `stratum.session_id`, ordered by `stratum.turn_number`.
- Find problems: `select(.level >= 40)`; `status` on a `proxy error` line is the
  HTTP status returned (5xx bodies are generic; the detail is only in `err`).
- Check start-up: `CQ Proxy running` gives `port`, `host` bind warnings and `mode`.
