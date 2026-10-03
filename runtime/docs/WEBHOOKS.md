# WEBHOOKS.md — Webhook Integration Guide

## Overview

`POST /v1/webhooks/test` sends a signed sample of one of the four event types
below to the organization's configured endpoint. Automatic event sources are
not wired in the proxy (see [TELEMETRY.md](TELEMETRY.md)).

---

## Configuration

Set your webhook endpoint and secret via the API:

```bash
curl -X PATCH http://localhost:4080/v1/config \
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

Sample Historical Drift conflict payload: a stored memory contradicts Git history.

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

The sample illustrates a suppressed conflict. Sending it through the test endpoint does not perform an audit or suppress a fact.

---

### `fact.suppressed`

Sample fact-suppression payload, illustrating a Git-attestation conflict or manual suppression.

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

Sample evaluation-result payload. Sending it does not run an evaluation or apply configuration.

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

In the event format, `"failed"` pairs with `config_applied: false`; the test endpoint itself does not roll back configuration.

---

### `session.ended`

Sample session-end payload. `estimated_savings_usd` is an estimated USD cost difference, for information only. Ending a session does not yet automatically deliver this event.

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
    "facts_extracted": 7,
    "conflicts_detected": 1
  }
}
```

---

## Delivery and Retries

- Webhook delivery timeout: 10 seconds
- If your endpoint returns a non-2xx status or times out, CQ retries with exponential backoff: 5s, 30s, 5min, 30min, 2hr
- After 5 failed attempts, the event is marked as undelivered and logged
- Undelivered events are visible in the dashboard under Settings → Webhooks

## Testing Webhooks

Use the test endpoint to send a sample event to your configured webhook URL:
In commercial mode, this requires an unbound organization API key; a
project-bound key receives HTTP 403 before the webhook configuration is read.

```bash
curl -X POST http://localhost:4080/v1/webhooks/test \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"event_type": "conflict.detected"}'
```

For local development, use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose your local server:

```bash
ngrok http 3000
# Use the ngrok URL as your webhook endpoint during development
```
