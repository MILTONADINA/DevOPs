/**
 * Invoice ledger seam (Phase 6 / v1.0.0) — record an invoice on SEND + dedup re-sends by period.
 *
 * The `invoices` table previously got a row ONLY when the inbound Stripe webhook fired on payment, so a
 * sent-but-unpaid invoice was invisible (the missing half of the "sent + paid" v1.0.0 acceptance) and the
 * invoice runner had no local record to detect a duplicate --send. This seam closes both: it records a
 * status='sent' row at send time (which a later `invoice.paid` event upserts to 'paid' by stripe_invoice_id,
 * via the forward-only RPC) and lets the runner refuse a second send for the same (org, period).
 *
 * INJECTED (like the LLM-judge / Stripe-sink seams): a fake client unit-tests the SQL shape with no DB.
 * The DB-level partial unique index (migration 20260530020000) is the backstop under any TOCTOU race; this
 * seam is the clean application-layer guard + the persistent "sent" record.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** An existing invoice that blocks a re-send (any non-failed status for the same period). */
export interface ActiveInvoice {
  stripe_invoice_id: string;
  status: string;
}

/** A freshly-sent invoice to persist (status 'sent'). */
export interface SentInvoice {
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  /** ISO period bounds; omitted for an unbounded (all-time) invoice — those are NOT period-deduped. */
  periodStart?: string | undefined;
  periodEnd?: string | undefined;
}

export interface InvoiceLedger {
  /**
   * The existing non-failed invoice for this exact (org, period), or null. Period-bounded only — an
   * unbounded invoice has no period to dedup on (the Stripe-side idempotency key still guards it).
   *
   * @param orgId - the org.
   * @param periodStart - ISO period start.
   * @param periodEnd - ISO period end.
   * @returns the blocking invoice, or null if none.
   * @throws {Error} on a query failure.
   */
  findActiveForPeriod(orgId: string, periodStart: string, periodEnd: string): Promise<ActiveInvoice | null>;
  /**
   * Record a freshly-sent invoice (status 'sent') so the dashboard sees it and re-sends are deduped.
   *
   * @param orgId - the org.
   * @param inv - the sent-invoice fields.
   * @throws {Error} on an insert failure (incl. the partial-unique-index violation on a duplicate period).
   */
  recordSent(orgId: string, inv: SentInvoice): Promise<void>;
}

/** Live invoice ledger over Supabase (service-role). */
export function createSupabaseInvoiceLedger(client: SupabaseClient): InvoiceLedger {
  return {
    async findActiveForPeriod(orgId: string, periodStart: string, periodEnd: string): Promise<ActiveInvoice | null> {
      const { data, error } = await client
        .from("invoices")
        .select("stripe_invoice_id, status")
        .eq("org_id", orgId)
        .eq("period_start", periodStart)
        .eq("period_end", periodEnd)
        .neq("status", "failed")
        .limit(1);
      if (error) throw new Error(`findActiveForPeriod failed: ${error.message}`);
      const row = (data ?? [])[0] as ActiveInvoice | undefined;
      return row ?? null;
    },
    async recordSent(orgId: string, inv: SentInvoice): Promise<void> {
      const row: Record<string, unknown> = {
        org_id: orgId,
        stripe_invoice_id: inv.stripeInvoiceId,
        amount_cents: inv.amountCents,
        currency: inv.currency,
        status: "sent",
      };
      // Only set the period columns when bounded — a NULL period is excluded from the dedup index.
      if (inv.periodStart !== undefined) row["period_start"] = inv.periodStart;
      if (inv.periodEnd !== undefined) row["period_end"] = inv.periodEnd;
      const { error } = await client.from("invoices").insert(row);
      if (error) throw new Error(`recordSent failed: ${error.message}`);
    },
  };
}
