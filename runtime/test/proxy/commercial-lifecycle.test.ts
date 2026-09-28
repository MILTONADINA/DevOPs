// End-to-end COMPOSITION proof for commercial mode: auth + billing + the inbound Stripe webhook
// wired into ONE buildProxy with shared state, driven through the real billing→payment→read chain.
//
// The isolated unit tests cover each route alone; this proves they COMPOSE — that the /v1 auth gate
// gates billing but exempts the public /stripe/webhook, that org-scoping flows key→orgId→invoice, and
// that a webhook-recorded payment surfaces through GET /v1/billing/invoices. No DB, no Stripe, no API.

import { describe, test, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { BillingDeps, InvoiceRow } from "../../src/proxy/routes/billing";
import type { StripeWebhookDeps } from "../../src/proxy/routes/stripe-webhook";
import type { AuthDeps } from "../../src/proxy/auth";
import type { BillableRecord } from "../../src/billing/invoice";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

const ORG = "org-1";
const KEY = "cq_test_partnerkey";
const WHSEC = "whsec_lifecycle";
const NOW = 1_700_000_000;

const RECORD: BillableRecord = { session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h1" };

function sign(payload: string): string {
  return `t=${NOW},v1=${createHmac("sha256", WHSEC).update(`${NOW}.${payload}`, "utf8").digest("hex")}`;
}

/** A single coordinated fake backing both billing reads and webhook writes (the shared invoices store). */
function commercialFakes(): { auth: AuthDeps; billing: BillingDeps; stripeWebhook: StripeWebhookDeps; invoices: InvoiceRow[] } {
  const invoices: InvoiceRow[] = [];
  const auth: AuthDeps = {
    resolve: async (raw) => (raw === KEY ? { orgId: ORG, keyId: "k1" } : null),
    protectedPrefixes: ["/v1/"],
  };
  const billing: BillingDeps = {
    getOrgPlan: async (orgId) => (orgId === ORG ? "growth" : null),
    listBillingRecords: async (orgId) => (orgId === ORG ? [RECORD] : []),
    listRecords: async () => ({ records: [], total: 0 }),
    developerBreakdown: async () => [],
    listInvoices: async (orgId, q) => {
      const rows = orgId === ORG ? invoices : [];
      const filtered = q.status ? rows.filter((i) => i.status === q.status) : rows;
      return { invoices: filtered, total: filtered.length };
    },
  };
  const stripeWebhook: StripeWebhookDeps = {
    signingSecret: WHSEC,
    nowSec: () => NOW,
    recordPayment: async (p) => {
      // Upsert by stripe_invoice_id (mirrors the Supabase onConflict path).
      const existing = invoices.find((i) => i.stripe_invoice_id === p.stripeInvoiceId);
      const row: InvoiceRow = {
        id: existing?.id ?? `inv_${invoices.length + 1}`,
        created_at: "t0",
        stripe_invoice_id: p.stripeInvoiceId,
        amount_cents: p.amountCents,
        currency: "usd",
        status: p.status,
        paid_at: p.status === "paid" ? "t-paid" : null,
      };
      if (existing) Object.assign(existing, row);
      else invoices.push(row);
    },
  };
  return { auth, billing, stripeWebhook, invoices };
}

describe("commercial lifecycle composition (auth + billing + Stripe webhook in one app)", () => {
  test("billing→payment→read chain composes under the auth gate", async () => {
    const { auth, billing, stripeWebhook } = commercialFakes();
    const app = buildProxy({ cors: false, rateLimit: false, auth, billing, stripeWebhook });
    await app.ready();

    // 1) The /v1 billing API is GATED: no key → 401.
    const noKey = await app.inject({ method: "GET", url: "/v1/billing/invoice" });
    expect(noKey.statusCode).toBe(401);

    // 2) With the partner's key, the invoice computes org-scoped (growth → $99 floor).
    const invoiceRes = await app.inject({ method: "GET", url: "/v1/billing/invoice", headers: { authorization: `Bearer ${KEY}` } });
    expect(invoiceRes.statusCode).toBe(200);
    expect(invoiceRes.json()).toMatchObject({ orgId: ORG, plan: "growth", amountDueUsd: 99 });

    // 3) Before payment, the org has no recorded invoices.
    const before = await app.inject({ method: "GET", url: "/v1/billing/invoices", headers: { authorization: `Bearer ${KEY}` } });
    expect(before.json().total).toBe(0);

    // 4) Stripe posts a SIGNED invoice.paid to the PUBLIC webhook (no API key — signature is the auth).
    const event = JSON.stringify({ id: "evt_paid", type: "invoice.paid", data: { object: { id: "in_777", amount_paid: 9900, metadata: { org_id: ORG } } } });
    const hook = await app.inject({ method: "POST", url: "/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": sign(event) }, payload: event });
    expect(hook.statusCode).toBe(200);
    expect(hook.json()).toMatchObject({ received: true, status: "paid" });

    // 5) The recorded payment now surfaces through the gated read endpoint, scoped to the org.
    const after = await app.inject({ method: "GET", url: "/v1/billing/invoices?status=paid", headers: { authorization: `Bearer ${KEY}` } });
    expect(after.statusCode).toBe(200);
    expect(after.json().total).toBe(1);
    expect(after.json().invoices[0]).toMatchObject({ stripe_invoice_id: "in_777", status: "paid", amount_cents: 9900 });

    await app.close();
  });

  test("a forged webhook (bad signature) does NOT record a payment", async () => {
    const { auth, billing, stripeWebhook, invoices } = commercialFakes();
    const app = buildProxy({ cors: false, rateLimit: false, auth, billing, stripeWebhook });
    await app.ready();
    const event = JSON.stringify({ id: "evt_forged", type: "invoice.paid", data: { object: { id: "in_x", amount_paid: 1, metadata: { org_id: ORG } } } });
    const forged = await app.inject({ method: "POST", url: "/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" }, payload: event });
    expect(forged.statusCode).toBe(400);
    expect(invoices).toHaveLength(0); // nothing recorded from an unverified event
    await app.close();
  });

  test("the webhook cannot be reached with another org's key — but it needs no key at all (signature-scoped)", async () => {
    // Sanity: the webhook is org-attributed by the SIGNED metadata.org_id, not by a caller's key.
    const { auth, billing, stripeWebhook, invoices } = commercialFakes();
    const app = buildProxy({ cors: false, rateLimit: false, auth, billing, stripeWebhook });
    await app.ready();
    const event = JSON.stringify({ id: "evt_b", type: "invoice.paid", data: { object: { id: "in_b", amount_paid: 500, metadata: { org_id: "org-OTHER" } } } });
    const res = await app.inject({ method: "POST", url: "/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": sign(event) }, payload: event });
    expect(res.statusCode).toBe(200);
    expect(invoices[0]).toMatchObject({ stripe_invoice_id: "in_b" }); // attributed to org-OTHER from the signed metadata
    await app.close();
  });
});
