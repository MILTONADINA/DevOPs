/**
 * Invoice ledger seam (Phase 6 / v1.0.0) — claim a period before Stripe finalization.
 *
 * The `invoices` table previously got a row ONLY when the inbound Stripe webhook fired on payment, so a
 * sent-but-unpaid invoice was invisible (the missing half of the "sent + paid" v1.0.0 acceptance) and the
 * invoice runner had no local record to detect a duplicate --send. This seam closes both: it records a
 * status='sent' row at send time (which a later `invoice.paid` event upserts to 'paid' by stripe_invoice_id,
 * via the forward-only RPC) and lets the runner refuse a second send for the same (org, period).
 *
 * INJECTED (like the LLM-judge / Stripe-sink seams): a fake client unit-tests the SQL shape with no DB.
 * The invoice table's unique index is written after Stripe and cannot stop two concurrent sends.
 * The durable claim table (migration 20260924235900) is the pre-provider concurrency guard.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Invoice } from "../types/billing";
import type { InvoiceReceipt, InvoiceSink } from "./stripe-sink";
import { usdToCents } from "./stripe";

/** An existing invoice that blocks a re-send (any non-failed status for the same period). */
export interface ActiveInvoice {
  stripe_invoice_id: string;
  status: string;
}

/** A finalized invoice to persist (the existing ledger schema calls this status 'sent'). */
export interface SentInvoice {
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
}

export interface InvoiceLedger {
  /** Atomically reserve this period before a provider call; false means another runner already claimed it. */
  claimPeriod(orgId: string, periodStart: string, periodEnd: string): Promise<boolean>;
  /**
   * The existing non-failed invoice for this exact (org, period), or null.
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
    async claimPeriod(orgId: string, periodStart: string, periodEnd: string): Promise<boolean> {
      const { error } = await client.from("invoice_send_claims").insert({ org_id: orgId, period_start: periodStart, period_end: periodEnd });
      if (error?.code === "23505") return false;
      if (error) throw new Error(`claimPeriod failed: ${error.message}`);
      return true;
    },
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
      row["period_start"] = inv.periodStart;
      row["period_end"] = inv.periodEnd;
      const { error } = await client.from("invoices").insert(row);
      if (error) throw new Error(`recordSent failed: ${error.message}`);
    },
  };
}

/** Keep the durable claim after success or any ambiguous provider/ledger failure. */
export async function claimAndFinalizeInvoice(ledger: InvoiceLedger, sink: InvoiceSink, orgId: string, periodStart: string, periodEnd: string, invoice: Invoice): Promise<InvoiceReceipt> {
  if (!(await ledger.claimPeriod(orgId, periodStart, periodEnd))) throw new Error(`invoice send already claimed for org ${orgId} over ${periodStart} → ${periodEnd}; reconcile before retry`);
  const receipt = await sink.send(invoice);
  try {
    await ledger.recordSent(orgId, { stripeInvoiceId: receipt.id, amountCents: usdToCents(invoice.amountDueUsd), currency: "usd", periodStart, periodEnd });
  } catch (error) {
    throw new Error(`Stripe invoice ${receipt.id} finalized but local ledger write failed: ${error instanceof Error ? error.message : String(error)}; reconcile before retry`);
  }
  return receipt;
}
