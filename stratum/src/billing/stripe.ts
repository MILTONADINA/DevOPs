/**
 * Stripe invoice client (Phase 6 / v1.0.0) — the real send behind the InvoiceSink seam.
 *
 * Implements the Stripe customer → invoice-item → invoice → finalize flow over Stripe's REST API
 * (form-encoded, Bearer auth, amounts in INTEGER CENTS). The fetch is INJECTED, so the request
 * construction — crucially the dollars→cents conversion, the dangerous bug class — is fully unit-
 * tested with fake Stripe responses. What a fake CANNOT verify is whether the REAL Stripe API
 * accepts these exact requests; that''s gated on a Stripe TEST-MODE key (free, no charges) + an
 * end-to-end run. A LIVE key (sk_live_) is REFUSED until explicitly confirmed verified — so a subtly
 * wrong request can never move real money before a human has watched it work in test mode.
 */

import type { Invoice } from "../types/billing";
import type { InvoiceReceipt } from "./stripe-sink";

/** Minimal Stripe HTTP shape (the global fetch satisfies it) — injected for testability. */
export type StripeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface StripeConfig {
  secretKey: string;
  doFetch: StripeFetch;
  /** Allow a LIVE key (sk_live_). Default false — refuse until verified in test mode. */
  allowLiveKey?: boolean;
}

/** USD → integer cents (Stripe amounts are integer cents). The conversion that, if wrong, mischarges. */
export function usdToCents(usd: number): number {
  return Math.round((usd + Number.EPSILON) * 100);
}

/** Form-encode flat params (application/x-www-form-urlencoded; Stripe nests via `metadata[k]`). */
export function encodeForm(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function stripePost(cfg: StripeConfig, path: string, params: Record<string, string | number>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" };
  // Stripe dedups a retried POST carrying the same Idempotency-Key (24h window): a re-run for the same
  // org+period returns the ORIGINAL object instead of creating a duplicate customer / invoiceitem / invoice.
  // This is THE canonical double-charge defense (Stripe API: "Idempotent requests"). Without it, a network
  // retry after the request was accepted, a crash-restart, or an accidental re-run sends a SECOND real invoice.
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const r = await cfg.doFetch(`https://api.stripe.com${path}`, { method: "POST", headers, body: encodeForm(params) });
  const body = (await r.json()) as Record<string, unknown>;
  if (r.status >= 400) {
    const message = (body["error"] as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`;
    throw new Error(`Stripe ${path} failed: ${message}`);
  }
  return body;
}

async function stripeGet(cfg: StripeConfig, path: string): Promise<Record<string, unknown>> {
  const r = await cfg.doFetch(`https://api.stripe.com${path}`, { method: "GET", headers: { authorization: `Bearer ${cfg.secretKey}` }, body: "" });
  const body = (await r.json()) as Record<string, unknown>;
  if (r.status >= 400) {
    const message = (body["error"] as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`;
    throw new Error(`Stripe ${path} failed: ${message}`);
  }
  return body;
}

/**
 * Resolve the org's Stripe customer: find the existing one (by org_id metadata) or create it.
 * Without this lookup, every send POSTs a NEW customer for the same org — duplicate customers, each
 * accruing their own invoices, which defeats Stripe's per-customer dedup and fragments the billing
 * history so the audit trail can't be reconstructed from Stripe alone.
 *
 * @param cfg - the Stripe config (key + injected fetch).
 * @param orgId - the org whose customer to resolve.
 * @returns the Stripe customer id (existing or freshly created).
 */
async function findOrCreateCustomer(cfg: StripeConfig, orgId: string): Promise<string> {
  const query = `metadata['org_id']:'${orgId}'`;
  const found = await stripeGet(cfg, `/v1/customers/search?query=${encodeURIComponent(query)}&limit=1`);
  const data = found["data"] as Array<{ id?: unknown }> | undefined;
  if (Array.isArray(data) && data.length > 0 && typeof data[0]?.id === "string") return data[0]!.id;
  // Not found — create (keyed on org so a within-window retry of the FIRST create also dedups).
  const created = await stripePost(cfg, "/v1/customers", { "metadata[org_id]": orgId, description: `Stratum org ${orgId}` }, `stratum-customer-${orgId}`);
  return String(created["id"]);
}

/**
 * Send a finalized invoice for `invoice.amountDueUsd` to the org's Stripe customer.
 *
 * @param cfg - secret key + injected fetch + live-key guard.
 * @param invoice - the computed invoice (amount + period).
 * @returns the Stripe invoice id + status + amount.
 * @throws {Error} on an empty key, an un-confirmed live key, or any Stripe API error.
 */
export async function sendStripeInvoice(cfg: StripeConfig, invoice: Invoice): Promise<InvoiceReceipt> {
  if (cfg.secretKey === "") throw new Error("STRIPE_SECRET_KEY is empty — set a test-mode key (sk_test_…) to send invoices");
  if (cfg.secretKey.startsWith("sk_live_") && cfg.allowLiveKey !== true) {
    throw new Error("refusing a LIVE Stripe key (sk_live_): verify the flow in TEST MODE first, then pass allowLiveKey to enable real charges");
  }
  // Never create Stripe state for a non-positive amount. Stripe rejects a $0 invoiceitem — but only AFTER
  // the customer POST succeeds, leaving an orphaned customer with no invoice. A $0 amount (a starter/custom
  // org with no savings yet) is "nothing to bill", not a charge: fail BEFORE any API call so no state leaks.
  if (!(invoice.amountDueUsd > 0)) {
    throw new Error(`invoice for org ${invoice.orgId} has amountDueUsd=$${invoice.amountDueUsd.toFixed(2)} — nothing to charge (no Stripe call made)`);
  }

  // Deterministic idempotency base: a re-send for the same org + period collapses to a no-op on Stripe's
  // side (within the 24h window) rather than minting a second invoice. period bounds are stable labels.
  const idem = `${invoice.orgId}|${invoice.periodStart}|${invoice.periodEnd}`;
  const customerId = await findOrCreateCustomer(cfg, invoice.orgId);

  await stripePost(cfg, "/v1/invoiceitems", {
    customer: customerId,
    amount: usdToCents(invoice.amountDueUsd),
    currency: "usd",
    description: `Stratum token-arbitrage fee (${invoice.periodStart} → ${invoice.periodEnd}; 20% of $${invoice.totalSavingsUsd.toFixed(2)} saved)`,
  }, `${idem}|invoiceitem`);

  const created = await stripePost(cfg, "/v1/invoices", { customer: customerId, "metadata[org_id]": invoice.orgId, collection_method: "send_invoice", days_until_due: 15 }, `${idem}|invoice`);
  const invoiceId = String(created["id"]);

  const finalized = await stripePost(cfg, `/v1/invoices/${invoiceId}/finalize`, {}, `${idem}|finalize`);
  return { id: invoiceId, status: String(finalized["status"] ?? "open"), amountUsd: invoice.amountDueUsd };
}
