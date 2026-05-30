-- Migration: 20260530000000_invoice_payment_forward_only.sql
-- Fixes a financial data-integrity defect found in the Session-20 adversarial review: the inbound
-- Stripe webhook's blind upsert overwrote every column on conflict, so a STALE or out-of-order
-- `invoice.payment_failed` delivered AFTER `invoice.paid` (Stripe is at-least-once + does NOT guarantee
-- ordering) downgraded status 'paid' → 'failed' and nulled paid_at — making a PAID partner look unpaid
-- and destroying the payment evidence.
--
-- This RPC makes the merge ATOMIC and FORWARD-ONLY: once an invoice is 'paid', no later event can
-- downgrade its status, paid_at, or amount. It is idempotent under Stripe's at-least-once redelivery.

CREATE OR REPLACE FUNCTION record_invoice_payment(
  p_org_id            UUID,
  p_stripe_invoice_id TEXT,
  p_amount_cents      INTEGER,
  p_status            TEXT,
  p_event_id          TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO invoices (org_id, stripe_invoice_id, amount_cents, status, paid_at, last_event_id, updated_at)
  VALUES (
    p_org_id, p_stripe_invoice_id, p_amount_cents, p_status,
    CASE WHEN p_status = 'paid' THEN NOW() ELSE NULL END,
    p_event_id, NOW()
  )
  ON CONFLICT (stripe_invoice_id) DO UPDATE SET
    -- forward-only: once 'paid', status/paid_at/amount are STICKY — a non-paid event cannot undo a payment.
    amount_cents  = CASE WHEN invoices.status = 'paid' THEN invoices.amount_cents ELSE EXCLUDED.amount_cents END,
    status        = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE EXCLUDED.status END,
    paid_at       = CASE WHEN invoices.status = 'paid' THEN invoices.paid_at
                         WHEN EXCLUDED.status = 'paid' THEN NOW()
                         ELSE NULL END,
    last_event_id = EXCLUDED.last_event_id,  -- always record the last event seen (audit)
    updated_at    = NOW();
END;
$$;
