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

async function stripePost(cfg: StripeConfig, path: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
  const r = await cfg.doFetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm(params),
  });
  const body = (await r.json()) as Record<string, unknown>;
  if (r.status >= 400) {
    const message = (body["error"] as { message?: string } | undefined)?.message ?? `HTTP ${r.status}`;
    throw new Error(`Stripe ${path} failed: ${message}`);
  }
  return body;
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

  const customer = await stripePost(cfg, "/v1/customers", { "metadata[org_id]": invoice.orgId, description: `Stratum org ${invoice.orgId}` });
  const customerId = String(customer["id"]);

  await stripePost(cfg, "/v1/invoiceitems", {
    customer: customerId,
    amount: usdToCents(invoice.amountDueUsd),
    currency: "usd",
    description: `Stratum token-arbitrage fee (${invoice.periodStart} → ${invoice.periodEnd}; 20% of $${invoice.totalSavingsUsd.toFixed(2)} saved)`,
  });

  const created = await stripePost(cfg, "/v1/invoices", { customer: customerId, "metadata[org_id]": invoice.orgId, collection_method: "send_invoice", days_until_due: 15 });
  const invoiceId = String(created["id"]);

  const finalized = await stripePost(cfg, `/v1/invoices/${invoiceId}/finalize`, {});
  return { id: invoiceId, status: String(finalized["status"] ?? "open"), amountUsd: invoice.amountDueUsd };
}
