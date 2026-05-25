---
name: stripe-webhook-idempotency
description: Stripe-specific webhook idempotency -- signature verification with the constructEvent API, retry-id reuse via `event.id`, double-fulfilment guards on PaymentIntent / Charge / Invoice events. Extends the universal `security/webhook-idempotency` skill with Stripe's event-id discipline and signing-secret rotation patterns. Triggers on Stripe webhook handler authoring (`stripe.webhooks.constructEvent` references, Stripe-Signature header handling). OWASP ASI02 (Tool Misuse) defense.
---

# Stripe Webhook Idempotency

> Stripe-specific extension of the universal
> [`security/webhook-idempotency`](../../../universal/security/webhook-idempotency/SKILL.md)
> skill. Read that first for the provider-agnostic patterns
> (idempotency-key, replay-window, storage strategies). This skill layers
> Stripe's specifics on top: `constructEvent` for signature verification,
> `event.id` discipline, signing-secret rotation, and the per-event-type
> fulfilment guards that close ASI02 (Tool Misuse) for Stripe handlers.

**Tradeoff:** Stripe is the highest-volume webhook surface for most
applications and Stripe events drive money-moving side effects -- the
strictest place to get idempotency right. The cost: extra discipline on
signature verification, event-id handling, and event-type-specific
fulfilment checks beyond what the universal pattern provides.

---

## Why this matters

Stripe retries webhook delivery for up to 3 days on transient failures.
Every retry that lands after the receiver successfully processed the
event (but before the response made it back) is a duplicate. Production
incidents from missing this:

- Two charges on the same `payment_intent.succeeded`.
- Two emails on the same `invoice.payment_succeeded`.
- Two database updates on the same `customer.subscription.updated`.
- Stale fulfilment if a later retry of an earlier event arrives after a
  newer event has already been processed.

The universal patterns close the dedupe-key gap. Stripe-specific patterns
close the verification + fulfilment-guard gaps.

---

## Pattern 1 -- Verify the signature with `constructEvent`, not raw HMAC

Stripe signs every webhook delivery with the signing secret you set when
creating the webhook endpoint in the Stripe dashboard (or via the API).
Use `stripe.webhooks.constructEvent` -- it verifies the signature AND
parses the event into a typed `Stripe.Event`. Never roll your own HMAC
compare against the raw body; the library handles signature-version
quirks, replay-window enforcement, and constant-time comparison.

```ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const SIGNING_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

async function handleStripeWebhook(rawBody: string, signature: string) {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, SIGNING_SECRET);
  } catch (err) {
    // Invalid signature, malformed payload, OR replay-window exceeded
    // (Stripe SDK's default tolerance is 300 seconds).
    return new Response('invalid signature', { status: 400 });
  }
  // event is now a verified Stripe.Event with typed event.data.object.
}
```

Crucially: pass the RAW request body (the unparsed bytes), not a re-
serialized JSON. Next.js / Express / FastAPI / Fastify all have a
"raw body" middleware mode you must enable on the webhook route. A
re-serialized body has different bytes than what Stripe signed; verification
fails. This is the #1 first-time Stripe webhook failure mode.

---

## Pattern 2 -- Use `event.id` as the idempotency key, never derive from body

Stripe assigns every event a unique `event.id` (format `evt_...`). This is
the canonical retry identifier; Stripe guarantees the same id across
delivery attempts of the same event. Use it directly as your dedupe key
in whichever storage strategy fits your throughput profile (see the
universal skill for the Redis-TTL / DB-unique-constraint / in-memory
tradeoff).

```ts
const dedupeKey = `stripe:event:${event.id}`;
const claimed = await redis.set(dedupeKey, 'processing', { NX: true, EX: 86400 * 4 });
if (claimed !== 'OK') {
  return new Response('duplicate (idempotent)', { status: 200 });
}
```

The 4-day TTL covers Stripe's full 3-day retry schedule plus headroom.
Anything shorter risks a very-late retry slipping past your dedupe window.

---

## Pattern 3 -- Per-event-type fulfilment guards

`stripe.webhooks.constructEvent` returns a discriminated-union typed event.
Switch on `event.type` and apply fulfilment-state checks specific to that
type, NOT just the idempotency-key check. The idempotency key prevents
double-processing of the SAME event; fulfilment guards prevent processing
events in the wrong order.

```ts
switch (event.type) {
  case 'payment_intent.succeeded': {
    const pi = event.data.object;  // typed Stripe.PaymentIntent
    // Guard: do not fulfill if order is already shipped.
    const order = await db.order.findUnique({ where: { piId: pi.id } });
    if (order?.status === 'fulfilled') {
      return new Response('already fulfilled', { status: 200 });
    }
    await fulfillOrder({ orderId: order!.id, paymentIntentId: pi.id });
    break;
  }
  case 'charge.refunded': {
    const charge = event.data.object;  // typed Stripe.Charge
    await markOrderRefunded({ chargeId: charge.id });
    break;
  }
  default:
    // Ignore unhandled event types -- Stripe sends many event types per
    // endpoint, processing irrelevant ones is wasted work.
    break;
}
```

For event types that ARE expected to arrive multiple times legitimately
(e.g., `customer.subscription.updated` for the same subscription on
different state transitions), use the same idempotency key (`event.id`)
plus per-state-transition checks; don't conflate "I've seen this event
id" with "I've already processed this subscription state."

---

## Anti-patterns

### Anti-pattern 1 -- Re-serializing the body before signature verification

```ts
// WRONG
const body = await req.json();  // parses + re-serializes; signature breaks
const event = stripe.webhooks.constructEvent(JSON.stringify(body), signature, secret);
```

The body Stripe signed was the exact bytes that arrived; `JSON.stringify`
re-serializes with potentially different key order, different whitespace,
different number formatting. Verification fails 100% of the time. Use the
raw body bytes (`req.text()` or framework-specific raw-body middleware).

### Anti-pattern 2 -- Using `event.data.object.id` as the dedupe key

```ts
// WRONG
const dedupeKey = `stripe:pi:${event.data.object.id}`;  // payment_intent id, NOT event id
```

A single `PaymentIntent` produces multiple events (`payment_intent.created`,
`payment_intent.processing`, `payment_intent.succeeded`,
`payment_intent.canceled` ...). Using `data.object.id` as the dedupe key
treats them as duplicates of each other -- only the first event of a given
PaymentIntent is processed; everything else is silently dropped. Use
`event.id`, which is unique per event.

### Anti-pattern 3 -- Skipping signature verification in test mode

```ts
// WRONG
if (process.env.NODE_ENV !== 'production') {
  // Skip signature verification for local testing.
  const event = JSON.parse(rawBody);
}
```

A test-mode bypass leaks into production through misconfiguration
(`NODE_ENV=development` accidentally shipped, environment-variable typo,
container default that wasn't overridden). Always verify the signature;
use the Stripe CLI's `stripe listen --forward-to` for local development,
which provides a real signing secret.

---

## Signing-secret rotation

Stripe lets you create multiple active signing secrets per endpoint
(in the dashboard or via API). During rotation, both the OLD and NEW
secrets are valid for a window; verify against both before retiring the
old one.

```ts
async function verifyAgainstAnyActiveSecret(rawBody: string, signature: string) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET_NEW, process.env.STRIPE_WEBHOOK_SECRET_OLD]
    .filter((s): s is string => !!s);
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch { /* try next secret */ }
  }
  throw new Error('signature verification failed against all active secrets');
}
```

Once the new secret is active in the dashboard and traffic has cut over
(monitor delivery success in the Stripe dashboard), remove the old
secret from the environment and the endpoint config.

---

## ASI/AST mapping

This skill addresses **canonical OWASP ASI02 (Tool Misuse)** from
`governance/owasp-asi-2026/threats.md`. A replayed Stripe webhook
re-invokes a destructive tool: charge a card, send a customer email,
mark an order shipped, trigger a refund. The defense layer is structural
idempotency at the receiver, which Patterns 1 (verification) + 2 (event-id
key) + 3 (fulfilment guards) realize for Stripe-specific event surfaces.

---

## Testing

For each Stripe webhook handler, write at least four tests:

```ts
test('rejects invalid signature', async () => { /* mutated signature header */ });
test('rejects events outside replay window', async () => { /* timestamp 1h old */ });
test('idempotent on duplicate event.id', async () => { /* same event twice */ });
test('does not fulfill an already-fulfilled order', async () => { /* event after fulfilment */ });
```

The Stripe CLI's `stripe trigger` command produces real signed test
events you can replay against a local handler -- the most realistic
fixture short of production traffic.

---

## See also

- Universal: `skills/universal/security/webhook-idempotency/SKILL.md`
- `governance/owasp-asi-2026/threats.md` -- ASI02 (Tool Misuse) full text
- Stripe docs: https://stripe.com/docs/webhooks/signatures (signature
  verification reference)
- `skills/stack-specific/stripe/pci-scope-minimization/SKILL.md` -- the
  PCI-scope companion skill; webhook handlers that touch payment data
  inherit the PCI scope of the integration overall.
