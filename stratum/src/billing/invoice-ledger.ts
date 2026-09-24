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
import type { VerifiedStripeInvoice } from "./stripe";

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

export interface ReconciledInvoice extends SentInvoice {
  status: "sent" | "paid";
  paidAt?: string;
}

export interface InvoiceLedger {
  /** Atomically reserve this period before a provider call; false means another runner already claimed it. */
  claimPeriod(orgId: string, periodStart: string, periodEnd: string): Promise<boolean>;
  /** Read the durable claim without changing it. */
  hasClaim(orgId: string, periodStart: string, periodEnd: string): Promise<boolean>;
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
  /** Persist a provider-verified open/paid invoice after an ambiguous local write. */
  recordReconciled(orgId: string, inv: ReconciledInvoice): Promise<void>;
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
    async hasClaim(orgId: string, periodStart: string, periodEnd: string): Promise<boolean> {
      const { data, error } = await client.from("invoice_send_claims").select("org_id").eq("org_id", orgId).eq("period_start", periodStart).eq("period_end", periodEnd).limit(1);
      if (error) throw new Error(`hasClaim failed: ${error.message}`);
      return (data ?? []).length > 0;
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
    async recordReconciled(orgId: string, inv: ReconciledInvoice): Promise<void> {
      if (inv.currency !== "usd" || (inv.status === "paid" && !inv.paidAt)) throw new Error("recordReconciled requires verified USD amount and paid timestamp");
      const { error } = await client.rpc("reconcile_claimed_invoice", {
        p_org_id: orgId,
        p_period_start: inv.periodStart,
        p_period_end: inv.periodEnd,
        p_stripe_invoice_id: inv.stripeInvoiceId,
        p_amount_cents: inv.amountCents,
        p_status: inv.status,
        p_paid_at: inv.paidAt ?? null,
      });
      if (error) throw new Error(`recordReconciled failed: ${error.message}`);
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

/** Restore a missing local ledger row from one read-only, provider-verified invoice. */
export async function reconcileClaimedInvoice(
  ledger: InvoiceLedger,
  verify: () => Promise<VerifiedStripeInvoice>,
  orgId: string,
  periodStart: string,
  periodEnd: string,
  invoiceId: string,
  invoice: Invoice,
): Promise<VerifiedStripeInvoice> {
  if (!(await ledger.hasClaim(orgId, periodStart, periodEnd))) throw new Error("invoice reconciliation requires an existing period claim");
  const local = await ledger.findActiveForPeriod(orgId, periodStart, periodEnd);
  if (local && local.stripe_invoice_id !== invoiceId) throw new Error("local period has a different Stripe invoice");
  const verified = await verify();
  if (verified.id !== invoiceId) throw new Error("verified Stripe invoice ID differs from requested ID");
  if (local) {
    if (local.status === "paid" && verified.status !== "paid") throw new Error("local paid invoice cannot be downgraded");
  }
  await ledger.recordReconciled(orgId, {
    stripeInvoiceId: invoiceId,
    amountCents: usdToCents(invoice.amountDueUsd),
    currency: "usd",
    periodStart,
    periodEnd,
    status: verified.status === "paid" ? "paid" : "sent",
    ...(verified.paidAt ? { paidAt: verified.paidAt } : {}),
  });
  return verified;
}
