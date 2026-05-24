# WEBHOOKS.md — Webhook Integration Guide

## Overview

CQ sends webhook events to your configured endpoint for important system events. Webhooks allow you to build integrations that react in real time to conflicts, billing events, and system status changes.

---

## Configuration

Set your webhook endpoint and secret via the API:

```bash
curl -X PATCH https://proxy.startum.com/v1/config \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://your-app.com/webhooks/cq",
    "webhook_secret": "your-webhook-secret-32-chars-min"
  }'
```

Or via environment variable for self-hosted:
```
WEBHOOK_ENDPOINT=https://your-app.com/webhooks/cq
WEBHOOK_SECRET=your-webhook-secret
```

---

## Signature Verification

Every webhook request includes an `X-CQ-Signature` header. Verify it before processing:

```typescript
import crypto from "crypto";

function verifyWebhookSignature(
  payload: string,          // raw request body as string
  signature: string,        // X-CQ-Signature header value
  secret: string            // your webhook secret
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");

  const received = signature.replace("sha256=", "");

  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
}

// Express.js example
app.post("/webhooks/cq", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.headers["x-cq-signature"] as string;
  const isValid = verifyWebhookSignature(req.body.toString(), signature, WEBHOOK_SECRET);

  if (!isValid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(req.body.toString());
  handleEvent(event);
  res.status(200).json({ received: true });
});
```

**Always verify the signature.** Do not process webhook payloads that fail verification.

---

## Event Types

### `conflict.detected`

Fired when Git-attestation detects a Historical Drift conflict — a stored memory that contradicts the Git commit history.

```json
{
  "event": "conflict.detected",
  "id": "evt_uuid",
  "created_at": "2026-04-06T14:23:00Z",
  "org_id": "uuid",
  "data": {
    "conflict_id": "uuid",
    "session_id": "uuid",
    "fact_type": "FunctionChange",
    "fact_id": "uuid",
    "claimed_state": "fetchUser() introduced in commit a3f9b2d",
    "actual_state": "fetchUser() deleted in commit c7d1e4f on 2026-03-02",
    "conflict_commit": "c7d1e4f",
    "suppressed": true
  }
}
```

**Recommended action:** Alert the relevant developer. Display in your internal tooling. The memory has already been suppressed — no action is required to prevent injection, but the underlying codebase state should be reviewed.

---

### `fact.suppressed`

Fired when any structured fact is suppressed — either by Git-attestation conflict or manually via the API.

```json
{
  "event": "fact.suppressed",
  "id": "evt_uuid",
  "created_at": "2026-04-06T14:23:00Z",
  "org_id": "uuid",
  "data": {
    "fact_id": "uuid",
    "fact_type": "TechDecision",
    "suppression_reason": "git_conflict",
    "suppressed_by": "audit_engine"
  }
}
```

`suppression_reason` values: `"git_conflict"`, `"manual"`, `"opus_audit"`

---

### `eval.completed`

Fired after a configuration change triggers an automatic eval run (e.g., after updating λ, g, or θ).

```json
{
  "event": "eval.completed",
  "id": "evt_uuid",
  "created_at": "2026-04-06T14:23:00Z",
  "org_id": "uuid",
  "data": {
    "config_change_id": "uuid",
    "result": "passed",
    "faithfulness_before": 0.924,
    "faithfulness_after": 0.918,
    "answer_relevancy_before": 0.911,
    "answer_relevancy_after": 0.905,
    "critical_failures": 0,
    "config_applied": true
  }
}
```

`result` values: `"passed"`, `"failed"`

If `"failed"`, the configuration change has been rolled back. `config_applied` will be `false`.

---

### `session.ended`

Fired when a session ends (either explicitly via `DELETE /v1/sessions/:id` or after a configurable idle timeout).

```json
{
  "event": "session.ended",
  "id": "evt_uuid",
  "created_at": "2026-04-06T14:23:00Z",
  "org_id": "uuid",
  "data": {
    "session_id": "uuid",
    "developer_id": "uuid",
    "duration_seconds": 3642,
    "total_turns": 47,
    "total_original_tokens": 187400,
    "total_quarantined_tokens": 21300,
    "token_delta": 166100,
    "estimated_savings_usd": 4.98,
    "cq_fee_usd": 0.996,
    "facts_extracted": 7,
    "conflicts_detected": 1
  }
}
```

---

### `invoice.ready`

Fired on the 1st of each month when the monthly invoice is generated.

```json
{
  "event": "invoice.ready",
  "id": "evt_uuid",
  "created_at": "2026-05-01T00:00:00Z",
  "org_id": "uuid",
  "data": {
    "invoice_id": "uuid",
    "period": "2026-04",
    "total_original_tokens": 12400000,
    "total_quarantined_tokens": 1860000,
    "total_savings_usd": 315.20,
    "total_cq_fee_usd": 63.04,
    "due_date": "2026-05-15",
    "invoice_url": "https://proxy.startum.com/v1/billing/invoices/uuid/pdf"
  }
}
```

---

### `tee.attestation_failed`

Fired when a ZK-Context session's TEE attestation fails. This is a security event.

```json
{
  "event": "tee.attestation_failed",
  "id": "evt_uuid",
  "created_at": "2026-04-06T14:23:00Z",
  "org_id": "uuid",
  "data": {
    "session_id": "uuid",
    "reason": "pcr_mismatch",
    "expected_pcr0": "expected-hash",
    "received_pcr0": "received-hash"
  }
}
```

`reason` values: `"pcr_mismatch"`, `"expired_nonce"`, `"invalid_certificate_chain"`, `"unknown"`

**Recommended action:** Alert your security team immediately. Do not dismiss this event.

---

## Delivery and Retries

- Webhook delivery timeout: 10 seconds
- If your endpoint returns a non-2xx status or times out, CQ retries with exponential backoff: 5s, 30s, 5min, 30min, 2hr
- After 5 failed attempts, the event is marked as undelivered and logged
- Undelivered events are visible in the dashboard under Settings → Webhooks

## Testing Webhooks

Use the test endpoint to send a sample event to your configured webhook URL:

```bash
curl -X POST https://proxy.startum.com/v1/webhooks/test \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"event_type": "conflict.detected"}'
```

For local development, use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose your local server:

```bash
ngrok http 3000
# Use the ngrok URL as your webhook endpoint during development
```
