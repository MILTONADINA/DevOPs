-- Migration: 20260529180000_invoices.sql
-- Phase 6 / v1.0.0: persist the Stripe invoice lifecycle so the system can record
-- "invoice sent + PAID by design partner" (the v1.0.0 acceptance). sendStripeInvoice
-- (src/billing/stripe.ts) creates the invoice; the inbound Stripe webhook
-- (src/billing/stripe-webhook.ts + routes/stripe-webhook.ts) flips it to paid on the
-- signed `invoice.paid` callback.
--
-- Unlike billing_records (append-only USAGE facts), this is a small STATE table: a row
-- per Stripe invoice that transitions sent → paid/failed. `stripe_invoice_id` is UNIQUE
-- so the webhook can upsert idempotently (Stripe re-delivers events at-least-once).

CREATE TABLE invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  stripe_invoice_id  TEXT NOT NULL UNIQUE,                 -- idempotency key for webhook upserts
  amount_cents       INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency           TEXT NOT NULL DEFAULT 'usd',
  status             TEXT NOT NULL CHECK (status IN ('sent', 'paid', 'failed')),
  paid_at            TIMESTAMPTZ,                           -- set when status → paid
  last_event_id      TEXT                                  -- last Stripe evt_ applied (audit/idempotency)
);

CREATE INDEX invoices_org_id_idx ON invoices(org_id);
CREATE INDEX invoices_status_idx ON invoices(status);

-- Service-only access (no client RLS policy), matching the rest of the schema's posture
-- (PB-31: rls_enabled_no_policy is correct for a service-role-only backend).
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
