-- Migration: 20260530020000_invoices_period_dedup.sql
-- Phase 6 / v1.0.0: record an invoice on SEND (not only on payment) and dedup re-sends by period.
--
-- Today the invoices row appears only when the inbound Stripe webhook fires on PAYMENT, so a
-- sent-but-unpaid invoice is invisible — the missing half of the v1.0.0 "sent + paid" state. The
-- invoice runner now records a status='sent' row at send time. To make a second --send for the same
-- (org, period) a no-op at the DB layer (beyond the Stripe-side idempotency key's 24h window), a
-- PARTIAL UNIQUE index allows at most one NON-failed invoice per (org, period). A 'failed' invoice is
-- excluded so a payment failure can be re-invoiced; NULL-period rows (all-time/dev invoices, and the
-- webhook's own inserts when no send-row exists) are excluded so they never collide.

ALTER TABLE invoices
  ADD COLUMN period_start TIMESTAMPTZ,
  ADD COLUMN period_end   TIMESTAMPTZ;

CREATE UNIQUE INDEX invoices_org_period_active_uniq
  ON invoices (org_id, period_start, period_end)
  WHERE status <> 'failed' AND period_start IS NOT NULL AND period_end IS NOT NULL;
