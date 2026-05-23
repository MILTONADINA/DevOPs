---
name: stripe-webhook-idempotency
description: Stripe-specific webhook idempotency -- signature verification with the constructEvent API, retry-id reuse via `event.id`, double-fulfilment guards on PaymentIntent / Charge / Invoice events. Extends the universal `security/webhook-idempotency` skill with Stripe's event-id discipline and signing-secret rotation patterns. Triggers on Stripe webhook handler authoring (`stripe.webhooks.constructEvent` references, Stripe-Signature header handling). OWASP ASI02 (Tool Misuse) defense.
---

# Stripe Webhook Idempotency

> Phase 2 Step 4 scaffold. Skill body is authored in session 4 batch 2.
> See `specs/phase-2/D-stack-specific-skills.md` REQ-D1 through REQ-D7 for
> the requirement bar this skill satisfies. The universal counterpart lives
> at `skills/universal/security/webhook-idempotency/SKILL.md` (area G).
