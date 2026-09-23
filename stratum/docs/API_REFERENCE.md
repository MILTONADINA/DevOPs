# API_REFERENCE.md — Proxy API Endpoints

## Base URL

Development: `http://localhost:4080`
Production: `https://proxy.startum.com`

All endpoints require the header `Authorization: Bearer <org_api_key>` except `/health`.

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
`2023-06-01`. (The proxy supplies its own `x-api-key` to Anthropic; you authenticate to CQ with your
CQ key via `Authorization: Bearer` or `x-api-key`.)

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

Returns token statistics for a session.

**Response:**
```json
{
  "session_id": "uuid",
  "turns_total": 42,
  "total_original_tokens": 187400,
  "total_quarantined_tokens": 21300,
  "total_token_delta": 166100,
  "estimated_savings_usd": 4.98,
  "cq_fee_usd": 0.996,
  "pruning_effectiveness_pct": 88.6,
  "facts_extracted": 7,
  "facts_verified": 5,
  "facts_suppressed": 1,
  "conflicts_detected": 1
}
```

### GET /v1/sessions

List sessions for the authenticated org.

**Query params:**
- `developer_id` (optional): filter by developer
- `since` (optional): ISO8601 date, return sessions after this date
- `limit` (optional): default 20, max 100
- `offset` (optional): pagination offset

---

## Billing

### GET /v1/billing/summary

Monthly billing summary for the org.

**Query params:**
- `month`: `YYYY-MM`, default: current month

**Response:**
```json
{
  "org_id": "uuid",
  "period": "2026-04",
  "total_original_tokens": 12400000,
  "total_quarantined_tokens": 1860000,
  "total_token_delta": 10540000,
  "total_cost_delta_usd": 315.20,
  "total_cq_fee_usd": 63.04,
  "total_sessions": 847,
  "average_pruning_effectiveness_pct": 85.0,
  "by_developer": [
    {
      "developer_id": "uuid",
      "name": "Milton R.",
      "token_delta": 4200000,
      "cq_fee_usd": 25.20
    }
  ]
}
```

### GET /v1/billing/records

Paginated list of billing records. For CFO audit use.

**Query params:**
- `since`, `until`: ISO8601 date range
- `session_id`: filter by session
- `limit`: default 50, max 500

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
      "cost_delta_usd": 0.217,
      "cq_fee_usd": 0.043,
      "signed_hash": "sha256:abc..."
    }
  ],
  "total": 847,
  "offset": 0,
  "limit": 50
}
```

### GET /v1/billing/invoices

The invoice lifecycle — what the inbound Stripe webhook (`POST /stripe/webhook`) records, so
"did the design partner pay?" is answerable via the API (not just SQL). Newest first.

**Query params:**
- `status`: filter by `sent` | `paid` | `failed` (invalid → 400)
- `limit`: default 50, max 500; `offset`: default 0

**Response:**
```json
{
  "invoices": [
    {
      "id": "uuid",
      "created_at": "2026-05-30T09:00:00Z",
      "stripe_invoice_id": "in_1abc...",
      "amount_cents": 9900,
      "currency": "usd",
      "status": "paid",
      "paid_at": "2026-05-30T11:42:00Z"
    }
  ],
  "total": 3,
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

---

## Configuration

### GET /v1/config

Returns org-level CQ configuration.

### PATCH /v1/config

Update org configuration. Changes apply to all new sessions.

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

### POST /stripe/webhook

No API key — Stripe authenticates via the `Stripe-Signature` header (HMAC-SHA256 of
`<timestamp>.<rawBody>` keyed by the endpoint signing secret `STRIPE_WEBHOOK_SECRET`).
Mounted OUTSIDE `/v1/`, so it bypasses the API-key gate; the **signature is the auth**.

Records the invoice lifecycle so the system knows "invoice **paid** by design partner"
(the v1.0.0 acceptance): `invoice.paid` / `invoice.payment_succeeded` → mark the invoice
paid (upsert into `invoices`, idempotent on `stripe_invoice_id` since Stripe re-delivers
at-least-once); `invoice.payment_failed` → mark failed; any other event → `200` ack, no-op.

A bad/stale/missing signature returns `400` (never acked as accepted); a verified event
returns `200 {received:true}`. Verification is over the RAW body (a re-serialized JSON body
would not match), with a 5-minute timestamp tolerance for replay defense.

### GET /docs

No authentication required. A human-browsable API reference page that renders
`/openapi.json` client-side — point a browser at it to see every endpoint, its
parameters, and responses, always current with the served spec. Self-contained
(no external CDN) and XSS-safe (textContent/createElement only), matching the CFO
dashboard's rendering convention. Verified end-to-end in a real browser (renders
all 18 operations from the live spec).

---

## Webhooks

CQ sends webhooks to your configured endpoint for:

| Event | Payload |
|---|---|
| `conflict.detected` | Conflict ID, fact details, commit hash |
| `fact.suppressed` | Fact ID, suppression reason |
| `eval.completed` | Config change ID, before/after scores |
| `session.ended` | Session ID, token stats |
| `invoice.ready` | Invoice ID, amount, period |

Webhook payloads are signed with HMAC-SHA256 using your webhook secret. Verify the `X-CQ-Signature` header before processing.
