# API_REFERENCE.md — Proxy API Endpoints

## Base URL

Local: `http://localhost:4080` (the proxy runs on your machine; there is no hosted instance)

---

## Authentication

Which requests need an API key depends on the proxy's mode — "personal" (the default) or
"commercial" (`CQ_COMMERCIAL=true` or `1`, with Supabase configured; the local-network spec below
calls this "auth configured"):

**Personal mode:** no request needs an API key, on any path, including `/v1/*`, `/health`,
`/openapi.json`, and `/docs`. Instead every request is gated on its network origin
(`specs/security/stratum-local-network.md`, REQ-1/REQ-2):
- `Host` must be a loopback name — `127.0.0.1`, `localhost`, or `[::1]`, or the configured
  `DEVOPS_PROXY_HOST` when it is itself a loopback address — with no port or with the proxy's own
  listening port (case-insensitive). Any other port gets `403`, so a port forward such as
  `localhost:5000` to a proxy listening on `4080` is refused. A missing or non-loopback `Host` gets
  `403`.
- No response ever carries `Access-Control-Allow-Origin`, so a browser page cannot read a
  cross-origin response even when it succeeds. A CORS preflight (`OPTIONS` with `Origin` and
  `Access-Control-Request-Method`) gets `403` outright.
- A same-machine client (curl, an SDK, another local process) hitting `http://localhost:4080` or
  `http://127.0.0.1:4080` sends no `Origin` and a loopback `Host`, so it is unaffected.

**Commercial mode:** every request under `/v1/*` requires the header
`Authorization: Bearer <org_api_key>` or `x-api-key: <org_api_key>` (see Usage, Configuration, and
Memory below for which key scope each endpoint needs). Only `/v1/*` is gated by a key — `/health`,
`/openapi.json`, `/docs`, and the `/dashboard` and `/dashboard/graph` HTML pages
stay public. `GET /dashboard/api` is the exception: it returns
`403` on every request in this mode, with a key or without one, because captured sessions carry no
tenant key. `Host` accepts any value unless `DEVOPS_PROXY_ALLOWED_HOSTS` is set, in which case only
its entries plus the loopback names above are accepted. `Access-Control-Allow-Origin` is sent only
for origins listed in `DEVOPS_PROXY_CORS_ORIGINS` (empty by default, so none by default); other
origins get no CORS header, same as personal mode. An entry `*` in that list means any origin: the
response then carries `Access-Control-Allow-Origin: *`, a deliberate widening of the allow-list.

In every mode, a request that carries more than one `Host` header gets `400` (REQ-2), even when each
line would be accepted on its own.

**Reaching the proxy from another device:** the proxy binds `127.0.0.1` unless `DEVOPS_PROXY_HOST`
(or its deprecated alias `HOST`) names another address. It refuses to start on a non-loopback (for
example bind-all) address unless auth is configured or
`DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1` is set (REQ-3 of the same spec). That opt-in only
allows the bind: with no auth every non-loopback `Host` still gets `403`, so the proxy is not
reachable from another machine by its address. Reaching it from another device takes auth
(`CQ_COMMERCIAL` with Supabase), and `DEVOPS_PROXY_ALLOWED_HOSTS` pins which `Host` names it accepts
(with auth and no allow-list, any `Host` is accepted). The `Host` check reads only the header the
client sends, so it is not authentication: with no auth, a client that can reach the bound address
and sends `Host: localhost` is served.

Both modes' `Host`/origin refusals return:

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_host` | Request carries more than one Host header (every mode) |
| 403 | `forbidden_host` | `Host` header missing, or not an accepted loopback/allow-listed name |
| 403 | `forbidden_origin` | Cross-origin preflight refused (personal mode only) |

---

## Anthropic-Compatible Proxy

### POST /v1/messages

Drop-in replacement for the Anthropic `/v1/messages` endpoint. Accepts the identical request shape. Prunes context before forwarding.

**Request:** Identical to [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

**Additional headers (optional):**
```
X-CQ-Session-Id: <uuid>        Override session ID (default: generated)
X-CQ-Dry-Run: true             Count tokens and prune, but don't forward to Anthropic
X-CQ-Disable-Pruning: true     Measure only, no pruning (Phase 1 behavior)
```

**Transparent header passthrough:** as a drop-in proxy, `anthropic-version` and `anthropic-beta`
on your request are forwarded upstream unchanged — your SDK's API version is honored and beta
opt-ins (e.g. `anthropic-beta`) are NOT dropped. When absent, the proxy defaults the version to
`2023-06-01`. (The proxy supplies its own `x-api-key` to Anthropic; in commercial mode, you
authenticate to CQ with your CQ key via `Authorization: Bearer` or `x-api-key` — personal mode needs
no CQ key, see Authentication above.)

**Response:** Identical to Anthropic API response, plus:
```json
{
  "id": "msg_...",
  "type": "message",
  "content": [...],
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 456
  },
  "cq_metadata": {
    "session_id": "uuid",
    "original_tokens": 8420,
    "quarantined_tokens": 1234,
    "token_delta": 7186,
    "pruning_log_id": "uuid",
    "billing_record_id": "uuid"
  }
}
```

**Errors:**

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed request body |
| 401 | `unauthorized` | Missing or invalid API key |
| 422 | `attestation_failed` | TEE attestation rejected (ZK-Context sessions only) |
| 429 | `rate_limited` | Upstream Anthropic rate limit hit |
| 502 | `upstream_error` | Anthropic API error |

---

## Session Management

### GET /v1/sessions/:id

Returns metadata for a session.

**Response:**
```json
{
  "id": "uuid",
  "created_at": "2026-04-06T12:00:00Z",
  "org_id": "uuid",
  "developer_id": "uuid",
  "model": "claude-opus-4-6",
  "config": {
    "lambda": 0.97,
    "gain_shift": 0.0,
    "theta": 1.0,
    "zk_enabled": true,
    "audit_enabled": true
  },
  "ended_at": null
}
```

### GET /v1/sessions/:id/stats

Returns token statistics for a session. `savingsUsd` is the estimated USD cost
difference, rounded to cents, for information only. `billingRecords` is the
number of usage rows; its existing field name is retained.

**Response:**
```json
{
  "sessionId": "uuid",
  "billingRecords": 42,
  "originalTokens": 187400,
  "quarantinedTokens": 21300,
  "savingsUsd": 4.98
}
```

### GET /v1/sessions/:id/erasure-preflight

Read-only inventory for an explicit session, requiring an authenticated
organization-level key. Personal mode and project-bound keys receive 403;
foreign, missing and internal sessions receive 404. Query parameters cannot
substitute another organization.

After C4-A/M2 the response remains `blocked_incomplete_inventory`. Reasons
include `graph_ownership_ambiguous` when applicable, `stores_not_inventoried`
while external copies/backups/RAM are unknown, and
`erasure_execution_unavailable`. `inventory.counts.billing_records` remains a
numeric usage count; a positive count does not create a financial blocker.
This route deletes nothing and does not establish erasure readiness.

### DELETE /v1/sessions/:id

Ends an explicit session by setting `ended_at`; it does not delete the session
or its content. No actual erasure endpoint is implemented yet. The retained
requirements are in `specs/memory/session-erasure.md`.

### GET /v1/sessions

List sessions for the authenticated org.

**Query params:**
- `developer_id` (optional): filter by developer
- `since` (optional): ISO8601 date, return sessions after this date
- `limit` (optional): default 20, max 100
- `offset` (optional): pagination offset

---

## Usage

The two retained `/v1/billing/*` paths report token usage and estimated USD
savings. They are wired by the commercial-mode entry point and require an
unbound organization API key; a project-bound key receives HTTP 403 because
the records and developer totals cover the whole organization. The default
personal-mode entry point does not register them. An app built explicitly with
usage dependencies and no auth can use the `?org-id` fallback.

Payment removal C1 (`specs/ops/payment-removal.md` REQ-1) removes `/billing`,
`/v1/billing/invoice`, `/v1/billing/audit.csv`, `/v1/billing/invoices`, and
`POST /stripe/webhook`. Those routes are no longer registered. C3 removes the
invoice CLI and other payment commands. C2 writes unsigned
usage records without fee/signature columns or a signing secret. C4-A/M2
retires the invoice tables/RPCs and the financial preflight blocker. Actual
API erasure and the one-year performance benchmark remain unfinished.

### GET /v1/billing/summary

Usage summary for the org. `total_cost_delta_usd` is an estimated USD cost
difference, rounded to cents, for information only. Token totals are exact
sums; pruning effectiveness is rounded to two decimal places (zero when
there are no original tokens).

**Query params:**
- `month`: optional `YYYY-MM`; when supplied, selects that calendar month
- `since`, `until`: optional ISO-8601 timestamps, inclusive start and exclusive
  end; `month` overrides their bounds. With no bounds the summary covers all time.

**Response:**
```json
{
  "org_id": "uuid",
  "period": "2026-04",
  "total_original_tokens": 12400000,
  "total_quarantined_tokens": 1860000,
  "total_token_delta": 10540000,
  "total_cost_delta_usd": 315.20,
  "total_sessions": 847,
  "average_pruning_effectiveness_pct": 85.0,
  "by_developer": [
    {
      "developer_id": "uuid",
      "name": "Milton R.",
      "token_delta": 4200000
    }
  ]
}
```

### GET /v1/billing/records

Paginated usage records. Each `cost_delta_usd` is an estimated USD cost
difference, for information only. Fee and signature fields are not returned.

**Query params:**
- `since`, `until`: ISO8601 date range
- `session_id`: filter by session
- `limit`: default 50, max 500
- `offset`: default 0

**Response:**
```json
{
  "records": [
    {
      "id": "uuid",
      "created_at": "2026-04-06T14:23:00Z",
      "session_id": "uuid",
      "original_tokens": 8420,
      "quarantined_tokens": 1180,
      "token_delta": 7240,
      "cost_delta_usd": 0.217
    }
  ],
  "total": 847,
  "offset": 0,
  "limit": 50
}
```

---

## Memory

### GET /v1/memory/facts

Retrieve structured facts for the org.

**Query params:**
- `fact_type`: `FunctionChange` | `TechDecision` | `PolicyUpdate` | `Todo` | `VariableChange`
- `session_id`: filter to one session
- `verified_only`: `true` | `false` (default false)
- `since`, `until`: date range
- `limit`: default 20, max 100

### DELETE /v1/memory/facts/:id

Suppress a fact manually. Sets `is_suppressed = true`.

### GET /v1/memory/conflicts

List all detected Historical Drift conflicts.

**Response:**
```json
{
  "conflicts": [
    {
      "id": "uuid",
      "detected_at": "2026-04-06T09:00:00Z",
      "fact_type": "FunctionChange",
      "claimed_state": "fetchUser() introduced in commit a3f9b2d",
      "actual_state": "fetchUser() deleted in commit c7d1e4f on 2026-03-02",
      "conflict_commit": "c7d1e4f",
      "suppressed": true
    }
  ]
}
```

### GET /v1/memory/audit-statuses

List the authenticated organization's latest persisted Tier-1 audit outcomes,
newest first. In personal mode, pass `?org-id=<uuid>`. `limit` defaults to 50
and is capped at 500. A missing row means unaudited; manual suppression does
not create a `CONFLICT` badge.

Each `statuses` item has `fact_table`, `fact_id`, `status` (`CONFIRMED`,
`UNVERIFIED`, or `CONFLICT`), `audited_at`, `evidence_commit`, and `detail`.

### GET /v1/memory/graph

Return a bounded Tier-3 graph snapshot for the authenticated organization.
In personal mode, pass `?org-id=<uuid>`. `limit` defaults to 100 entities and
is capped at 500. The response contains `entities` (`id`, `kind`, `name`,
`session_id`, `file_path`, `summary`) and at most 500 `edges` (`id`, `edge_type`, `from_entity`,
`to_entity`); both endpoints of every edge are in the returned entity set.

### GET /v1/memory/graph/search

Search across the authenticated organization's entire graph, including nodes
outside the recent snapshot. `q` is required, trimmed, and must be 2–100
characters. `mode=name` (default) ranks literal substrings before similar
spellings. `mode=semantic` ranks indexed File and Function nodes by offline
ONNX embedding similarity; run source-graph ingestion to populate those
vectors. The local model cache must be present for semantic queries.
The response contains up to 20 `matches` (entity IDs), plus `entities` and
`edges` for those matches and their immediate neighbors (at most 220 nodes
and 200 edges). In personal mode, pass `?org-id=<uuid>`.

### GET /v1/memory/graph/files and /v1/memory/graph/dependencies

Traverse all File nodes or DEPENDS_ON edges for the authenticated organization
in stable keyset order. `limit` defaults to 500 and must be 1–500. Pass the
returned `next` value as `after` until `next` is null. A file cursor is a file
name; a dependency cursor is an edge UUID. Each response contains at most 500
`files` or `edges`. In personal mode, pass `?org-id=<uuid>`.

### GET /v1/memory/graph/related-facts

Return up to 50 active Tier-2 fact summaries for an indexed File node in the
authenticated organization. `file` must be its exact project-relative path.
FunctionChange facts match `file_path`; TechDecision facts match only when
`domain` is that full path. Suppressed facts and generic domains are excluded.
The response reads durable File-to-fact links maintained by database triggers;
the backing facts are checked again for active status. An unindexed path
returns 404. In personal mode, pass `?org-id=<uuid>`.

---

## Configuration

### GET /v1/config

Returns org-level CQ configuration.

### PATCH /v1/config

Update org configuration. Changes apply to all new sessions.
In commercial mode, use an unbound organization API key. A project-bound key
receives HTTP 403; `GET /v1/config` remains available to authenticated keys.

**Request body (all fields optional):**
```json
{
  "lambda": 0.95,
  "gain_shift": 0.1,
  "theta": 1.2,
  "zk_enabled": true,
  "audit_enabled": true
}
```

Note: changing `lambda`, `gain_shift`, or `theta` triggers an automatic re-run of the eval suite against your org's historical sessions. You will receive a webhook notification with the results before the change takes effect.

---

## Utility

### GET /health

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "proxy": "healthy",
  "supabase": "healthy",
  "pinecone": "healthy",
  "neo4j": "healthy",
  "tee": "healthy"
}
```

### POST /v1/tokens/count

Count tokens without proxying a request.

**Request:**
```json
{
  "model": "claude-opus-4-6",
  "messages": [...]
}
```

**Response:**
```json
{
  "input_tokens": 8420
}
```

### GET /openapi.json

No authentication required. Returns the machine-readable OpenAPI 3.1 spec for this
API — the same contract this document describes, in a form clients can use to
generate SDKs, validate requests, or render Swagger UI. Served publicly even when
`/v1/*` auth is enabled, so a client can read the contract before it has a key.

Source of truth: `src/proxy/openapi.ts`. A test (`test/proxy/openapi.test.ts`)
asserts every documented path is an actually-registered route and every `$ref`
resolves, so the spec cannot drift from the implementation.

### GET /docs

No authentication required. A human-browsable API reference page that renders
`/openapi.json` client-side — point a browser at it to see every endpoint, its
parameters, and responses, always current with the served spec. Self-contained
(no external CDN) and XSS-safe (textContent/createElement only). It renders the
operations currently listed in the served spec.

---

## Webhooks

`POST /v1/webhooks/test` can send a sample of each supported event to the
organization's configured endpoint. Automatic event delivery is not wired in
the proxy (see [TELEMETRY.md](TELEMETRY.md)). Supported event types are:

| Event | Payload |
|---|---|
| `conflict.detected` | Conflict ID, fact details, commit hash |
| `fact.suppressed` | Fact ID, suppression reason |
| `eval.completed` | Config change ID, before/after scores |
| `session.ended` | Session ID, token stats |

Webhook payloads are signed with HMAC-SHA256 using your webhook secret. Verify the `X-CQ-Signature` header before processing.
