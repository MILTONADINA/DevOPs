---
name: webhook-idempotency
description: Defend against double-processing of webhook events across every provider (Stripe, GitHub, Slack, Twilio, SendGrid). Idempotency-key pattern + replay-window enforcement + dedupe-storage strategy. Triggers on any webhook handler authoring (route matching /webhook(s)?/, Stripe-Signature / X-Hub-Signature-256 header references). Defense against OWASP ASI02 (Tool Misuse) -- a replayed webhook that re-triggers a destructive tool is the canonical control-flow-level replay attack. Universal across providers; stack-specific signature verification lives in stack-specific skills.
---

# Webhook Idempotency

> Defends against **OWASP ASI02 (Tool Misuse)** -- specifically, the control-flow
> replay path where a webhook delivery retries (legitimately or maliciously) and
> the receiver double-processes the event, triggering a side effect (charge,
> deploy, notification, inventory mutation) more than once.

**Tradeoff:** Adds a dedupe-store dependency (Redis / DB unique constraint / etc.)
plus a per-event read-before-act. Worth it: webhook double-processing is a
recurring production-critical defect across every provider that emits HTTP
webhooks. The cost of NOT having this is a charge billed twice, an email sent
twice, a deploy re-run mid-flight.

---

## The threat

Webhook delivery is retried on transient failures (network blip, 5xx response,
timeout). Most providers retry aggressively -- Stripe retries on a backoff
schedule for up to 3 days; GitHub retries 3-8 times depending on the delivery
type. Every retry that lands AFTER the receiver successfully processed (but
before the response made it back to the provider) is a duplicate.

Mapping to **ASI02 (Tool Misuse)**: if the webhook handler invokes a
destructive tool (charge a card, send a notification, deploy an environment,
mutate inventory), a replayed delivery re-invokes that tool. The agent layer's
prompt-injection-defense (ASI01) does not protect against this -- the replay
is a legitimate-looking webhook from the legitimate provider, just delivered
multiple times. The control-flow-level defense is structural idempotency on
the receiver, NOT content-level sanitization.

---

## Idempotency key

The **idempotency key** is a stable, per-event identifier the provider assigns.
A correctly designed receiver:

1. Reads the idempotency key from the incoming request (NOT computed from
   the body content -- see anti-patterns).
2. Looks up the key in a dedupe store.
3. If the key is already present and marked "processed", returns the prior
   response without re-invoking the handler logic.
4. If the key is absent or marked "in-flight", records the key (with TTL),
   runs the handler, then marks the key "processed".

The key field name differs per provider but the pattern is constant:

| Provider | Idempotency key source |
|----------|------------------------|
| Stripe | `event.id` (in the webhook payload body) |
| GitHub | `X-GitHub-Delivery` header (UUID per delivery) |
| Slack | `event_id` in the payload + `X-Slack-Request-Timestamp` |
| Twilio | `MessageSid` in the payload |
| SendGrid | `sg_event_id` per event in the batch |

The key is what makes idempotency idempotency: same key arriving twice means
the same event arriving twice, regardless of what the body or headers look
like otherwise.

---

## Replay window

Even with idempotency keys, a stale-but-valid event delivered hours or days
later may not deserve processing. The **replay window** is a configurable
time-bound that rejects events whose payload timestamp falls outside it.

Typical recommendation: **5 minutes (300 seconds)** of skew tolerance. Stripe's
own recommendation in their docs is "tolerance of 300 seconds"; this matches
HMAC-signed-request best practice across most providers.

The replay-window check is independent of the idempotency-key check:

- **Idempotency-key check** -- "have I already processed *this specific*
  event?"
- **Replay-window check** -- "is *any* event with this timestamp still in
  scope for processing?"

Reject events whose timestamp is more than 300 seconds (or your configured
window) before the current server time. This defends against stored-and-
replayed deliveries where an attacker who captured a webhook payload tries
to replay it later. Note that the replay-window depends on a verified
signed timestamp from the provider; raw payload timestamps without
signature verification are not trustable inputs.

---

## Storage strategies

Three storage backends are common for the idempotency-key dedupe set. Each
has a "fails when" caveat -- pick the one that fails least disastrously for
your throughput and reliability profile.

### Strategy 1 -- Redis with TTL

Use `SETNX key value EX 86400` (set-if-not-exists with 24h TTL) as the
atomic "have I seen this key?" primitive.

- **Pros**: O(1) check + write; battle-tested for high throughput; the TTL
  bounds memory growth automatically.
- **Fails when**: Redis is unavailable (network partition, memory eviction
  policy kicks in, the operator forgot to enable persistence). The TTL also
  means events delivered MORE than 24h after their first processing
  (extremely-delayed retries) will be re-processed. For Stripe's 3-day
  retry schedule, set TTL >= 4 days.

### Strategy 2 -- Database unique constraint

Add a `processed_events` table with a `UNIQUE` constraint on the
idempotency-key column. INSERT inside the handler transaction; rely on the
DB's constraint violation as the dedupe signal.

- **Pros**: Atomic with the handler's own writes (same transaction);
  durable beyond Redis evictions; queryable for audit.
- **Fails when**: High webhook throughput hits write contention on the
  unique index; long-running handler transactions hold locks. Mitigated by
  inserting the key FIRST in a small transaction, then doing the actual
  side-effect work after. Also fails when the DB's isolation level allows
  phantom reads between the SELECT and INSERT -- use the constraint as
  the single source of truth, not a check-then-insert pattern.

### Strategy 3 -- In-memory LRU (low-volume only)

A bounded LRU cache (e.g., 10000 most-recent keys) in process memory.

- **Pros**: Zero infrastructure dependency; lowest latency; appropriate for
  low-volume single-instance receivers.
- **Fails when**: The process restarts (deploy, crash, scale-out) -- all
  remembered keys are gone, and the NEXT retry of any in-flight event
  re-processes. Also fails when traffic scales beyond LRU capacity; older
  keys evict and re-processing risk reappears for those. Strictly NOT
  acceptable for multi-instance receivers without sticky routing.

For PCI-scoped or financial-side-effect handlers, Strategy 2 (DB unique
constraint) is the conservative default. For mid-throughput notification
or sync handlers, Strategy 1 (Redis TTL) is the typical pick. Strategy 3
is rarely the right answer outside dev/test environments.

---

## Worked examples

### Stripe (TypeScript / Node.js)

```ts
// webhook-stripe.ts -- synthetic example, no live network, PII redacted
import Stripe from 'stripe';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const REPLAY_WINDOW_SECONDS = 300;

async function handleStripeWebhook(rawBody: string, signatureHeader: string) {
  // 1. Verify signature (provider-specific; verification + idempotency are
  //    orthogonal concerns -- both required).
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, SIGNING_SECRET);
  } catch {
    return { status: 400, body: 'invalid signature' };
  }

  // 2. Replay-window check on the signed timestamp (300 second skew).
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created) > REPLAY_WINDOW_SECONDS) {
    return { status: 400, body: 'event outside replay window' };
  }

  // 3. Idempotency-key check (Redis SETNX with 4-day TTL covering Stripe's
  //    72-hour retry schedule plus headroom).
  const dedupeKey = `stripe:event:${event.id}`;
  const claimed = await redis.set(dedupeKey, 'processing', { NX: true, EX: 86400 * 4 });
  if (claimed !== 'OK') {
    // Already processed (or in-flight by another worker); replay-safe no-op.
    return { status: 200, body: 'duplicate (idempotent)' };
  }

  // 4. Run handler. Synthetic event.data.object with PII redacted.
  // Example shape: { customer_email: "redacted@example.test", amount: 1999 }
  await runStripeEventHandler(event);

  await redis.set(dedupeKey, 'processed', { EX: 86400 * 4 });
  return { status: 200, body: 'ok' };
}

async function runStripeEventHandler(_event: Stripe.Event) {
  // Side-effect implementation lives here -- charge ledger, fulfillment, etc.
  // Synthetic placeholder: no live network in this example.
}
```

### GitHub (Python / FastAPI)

```python
# webhook_github.py -- synthetic example, no live network, PII redacted
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException
from sqlalchemy import Column, String, DateTime, create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime, timezone

app = FastAPI()
Base = declarative_base()
engine = create_engine("postgresql+psycopg://localhost/app")  # placeholder
Session = sessionmaker(bind=engine)

class ProcessedEvent(Base):
    __tablename__ = "processed_events"
    delivery_id = Column(String, primary_key=True)  # UNIQUE by virtue of PK
    received_at = Column(DateTime(timezone=True), nullable=False)

REPLAY_WINDOW_SECONDS = 300

@app.post("/api/webhook/github")
async def handle_github_webhook(req: Request):
    raw_body = await req.body()
    signature = req.headers.get("X-Hub-Signature-256", "")
    delivery_id = req.headers.get("X-GitHub-Delivery", "")
    timestamp_header = req.headers.get("X-GitHub-Hook-Installation-Target-ID", "")

    # 1. Verify signature (HMAC-SHA256 with shared secret).
    secret = b"placeholder-secret-redacted"  # in prod: load from vault
    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="invalid signature")

    # 2. Replay-window check on the delivery-attempt timestamp. GitHub
    #    publishes the timestamp in a separate header on signed-delivery
    #    feeds; here we use the body's "created_at" as an example.
    payload = await req.json()
    created_at_iso = payload.get("created_at", "")
    if created_at_iso:
        created_at = datetime.fromisoformat(created_at_iso.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        if abs((now - created_at).total_seconds()) > REPLAY_WINDOW_SECONDS:
            raise HTTPException(status_code=400, detail="event outside replay window")

    # 3. Idempotency-key check via DB unique constraint on delivery_id.
    session = Session()
    try:
        session.add(ProcessedEvent(delivery_id=delivery_id, received_at=datetime.now(timezone.utc)))
        session.commit()
    except IntegrityError:
        session.rollback()
        return {"status": "duplicate (idempotent)"}
    finally:
        session.close()

    # 4. Run handler. Synthetic payload with PII redacted -- e.g.
    #    { "sender": { "login": "REDACTED" }, "repository": { "name": "REDACTED" } }
    run_github_event_handler(payload)
    return {"status": "ok"}

def run_github_event_handler(_payload: dict) -> None:
    # Side-effect implementation lives here. Synthetic placeholder.
    pass
```

Both examples are self-contained, deterministic (no live network), and use
synthetic payloads with PII fields explicitly redacted to `redacted@example.test`,
`REDACTED`, or placeholder secrets. Adapt to your own infrastructure
(connection strings, dedupe-store choice per the Strategy 1/2/3 tradeoff
above).

---

## Anti-patterns

The following patterns SHALL NOT appear in production webhook handlers. Each
fails for the reason given.

1. **Body-hash as idempotency key.** Computing `sha256(request.body)` and
   using THAT as the dedupe key. **Fails when** the provider's retry includes
   a legitimate body change (e.g., GitHub adds a retry counter to the body;
   Stripe re-serializes JSON with different key ordering). Same logical event,
   different hash, re-processed. Use the provider's explicit event id, not
   the body content.

2. **In-memory dedupe store without persistence.** A `Set<string>` in process
   memory holding the seen keys. **Fails when** the process restarts -- every
   in-flight retry that lands post-restart is treated as new. Common on
   serverless platforms where containers are recycled aggressively. Use a
   shared dedupe store (Redis / DB) for any multi-instance or restart-prone
   deployment.

3. **Silent re-process on dedupe-store unavailability.** If Redis is down,
   skip the dedupe check and "fail open" to processing the event. **Fails when**
   it most matters -- precisely during the dedupe-store outage, the receiver
   processes EVERY retry. Fail closed instead: return 503 if the dedupe store
   is unavailable, let the provider retry later when the store is back.

---

## Provider-specific extensions

For providers with distinctive primitives that go beyond the universal
pattern, see the stack-specific skills:

- **Stripe-specific** -- `skills/stack-specific/stripe/webhook-idempotency`
  (signature verification, fulfillment guards, payment-intent state)
- (others to be added as patterns surface)

This universal skill stays provider-agnostic on purpose: idempotency-key +
replay-window + dedupe storage are the load-bearing primitives across every
provider. Stack-specific quirks layer on top.

---

## Testing

Author replay tests in your handler test suite:

```ts
test("duplicate Stripe webhook delivery is idempotent", async () => {
  const payload = stripeSyntheticEvent({ id: "evt_test_replay_1" });
  const res1 = await handler(payload, validSignature);
  const res2 = await handler(payload, validSignature);
  expect(res1.status).toBe(200);
  expect(res2.status).toBe(200);
  expect(res2.body).toContain("duplicate");
  // Side effect (e.g., DB row, ledger entry) ran exactly ONCE.
  expect(await countLedgerEntries({ event_id: "evt_test_replay_1" })).toBe(1);
});
```

A successful idempotency suite has the property: same event delivered N
times → 1 side effect, N - 1 "duplicate" responses.

---

## When this skill is working

- OWASP ASI02 red-team probes that include webhook-replay vectors return 0
  successful double-processing.
- Production incident reports stop mentioning "billed twice", "email
  sent twice", "deploy ran twice from the same trigger".
- Webhook-handler PRs include a duplicate-delivery test as a standard part
  of the review checklist.

---

## See also

- `governance/owasp-asi-2026/threats.md` -- ASI02 (Tool Misuse) full reference
- `skills/stack-specific/stripe/webhook-idempotency` -- Stripe-specific
  extension (area D; Phase 2 implementation pending)
- Renovate / Dependabot webhook noise: out of scope; this skill is about
  webhooks that trigger application side effects, not DevOps platform
  notifications.
