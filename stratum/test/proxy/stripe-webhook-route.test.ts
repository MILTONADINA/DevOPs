// Route test for POST /stripe/webhook (the inbound Stripe payment callback). Real fastify (the raw-body
// content-type parser must run), a constructed signature, and a fake recorder — no Stripe, no DB.

import { describe, test, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");
import type { PaymentRecord, StripeWebhookDeps } from "../../src/proxy/routes/stripe-webhook";

const SECRET = "whsec_route";
const NOW = 1_700_000_000;

function sign(payload: string, t = NOW, secret = SECRET): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex")}`;
}

function makeDeps(over: Partial<StripeWebhookDeps> = {}): { deps: StripeWebhookDeps; calls: PaymentRecord[] } {
  const calls: PaymentRecord[] = [];
  const deps: StripeWebhookDeps = { signingSecret: SECRET, nowSec: () => NOW, recordPayment: async (p) => { calls.push(p); }, ...over };
  return { deps, calls };
}

function post(app: ReturnType<typeof buildProxy>, payload: string, sig: string | undefined) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["stripe-signature"] = sig;
  return app.inject({ method: "POST", url: "/stripe/webhook", headers, payload });
}

describe("POST /stripe/webhook", () => {
  test("valid signature + invoice.paid → 200 and records the payment", async () => {
    const { deps, calls } = makeDeps();
    const app = buildProxy({ cors: false, rateLimit: false, stripeWebhook: deps });
    await app.ready();
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_99", amount_paid: 9900, metadata: { org_id: "org-7" } } } });
    const res = await post(app, payload, sign(payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, handled: "invoice.paid", status: "paid" });
    expect(calls).toEqual([{ orgId: "org-7", stripeInvoiceId: "in_99", amountCents: 9900, status: "paid", eventId: "evt_1" }]);
    await app.close();
  });

  test("a tampered body (bad signature) → 400 and does NOT record", async () => {
    const { deps, calls } = makeDeps();
    const app = buildProxy({ cors: false, rateLimit: false, stripeWebhook: deps });
    await app.ready();
    const payload = JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: { id: "in_1", metadata: { org_id: "o" } } } });
    const sig = sign(payload);
    const res = await post(app, payload + "X", sig); // body mutated after signing
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  test("missing Stripe-Signature header → 400", async () => {
    const { deps, calls } = makeDeps();
    const app = buildProxy({ cors: false, rateLimit: false, stripeWebhook: deps });
    await app.ready();
    const res = await post(app, JSON.stringify({ id: "e", type: "invoice.paid", data: { object: {} } }), undefined);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  test("an unrelated event type → 200, not recorded", async () => {
    const { deps, calls } = makeDeps();
    const app = buildProxy({ cors: false, rateLimit: false, stripeWebhook: deps });
    await app.ready();
    const payload = JSON.stringify({ id: "evt_3", type: "customer.created", data: { object: { id: "cus_1" } } });
    const res = await post(app, payload, sign(payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, handled: null });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  test("invoice.paid WITHOUT org_id metadata → 200 acked, not recorded (can't attribute)", async () => {
    const { deps, calls } = makeDeps();
    const app = buildProxy({ cors: false, rateLimit: false, stripeWebhook: deps });
    await app.ready();
    const payload = JSON.stringify({ id: "evt_4", type: "invoice.paid", data: { object: { id: "in_2", amount_paid: 1 } } });
    const res = await post(app, payload, sign(payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handled: null, reason: "no org_id metadata" });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  test("is PUBLIC under the /v1 auth gate (signature is the auth, not an API key)", async () => {
    const { deps } = makeDeps();
    const app = buildProxy({
      cors: false,
      rateLimit: false,
      stripeWebhook: deps,
      auth: { resolve: async () => null, protectedPrefixes: ["/v1/"] },
    });
    await app.ready();
    const payload = JSON.stringify({ id: "evt_5", type: "invoice.paid", data: { object: { id: "in_3", amount_paid: 5, metadata: { org_id: "o" } } } });
    const res = await post(app, payload, sign(payload));
    expect(res.statusCode).toBe(200); // NOT 401 — /stripe/webhook is outside /v1/
    // sanity: a /v1 route with no key is still gated
    const gated = await app.inject({ method: "GET", url: "/v1/config" });
    expect(gated.statusCode).toBe(401);
    await app.close();
  });
});
