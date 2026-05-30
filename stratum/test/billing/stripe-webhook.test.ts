// Tests for inbound Stripe webhook verification + routing (the "paid by design partner" half of
// v1.0.0). Constructs REAL HMAC signatures with a test secret — no Stripe, no network, no DB.

import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyStripeSignature, constructStripeEvent, stripeEventToAction, type StripeWebhookEvent } from "../../src/billing/stripe-webhook";

const SECRET = "whsec_test_abc";
const NOW = 1_700_000_000;

function sign(payload: string, secret = SECRET, t = NOW): string {
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},v1=${sig}`;
}

describe("verifyStripeSignature", () => {
  const payload = '{"id":"evt_1","type":"invoice.paid"}';

  test("accepts a valid signature within tolerance", () => {
    expect(verifyStripeSignature(payload, sign(payload), SECRET, { nowSec: NOW })).toBe(true);
  });

  test("rejects a tampered payload (HMAC no longer matches)", () => {
    expect(verifyStripeSignature(payload + " ", sign(payload), SECRET, { nowSec: NOW })).toBe(false);
  });

  test("rejects a wrong secret", () => {
    expect(verifyStripeSignature(payload, sign(payload), "whsec_other", { nowSec: NOW })).toBe(false);
  });

  test("rejects a stale timestamp (replay defense)", () => {
    // Signature is valid, but the signed t is 10 min old and tolerance is 5 min.
    const old = NOW - 600;
    expect(verifyStripeSignature(payload, sign(payload, SECRET, old), SECRET, { nowSec: NOW, toleranceSec: 300 })).toBe(false);
  });

  test("rejects a malformed / empty header and an empty secret (fail closed)", () => {
    expect(verifyStripeSignature(payload, "", SECRET, { nowSec: NOW })).toBe(false);
    expect(verifyStripeSignature(payload, "garbage", SECRET, { nowSec: NOW })).toBe(false);
    expect(verifyStripeSignature(payload, `t=${NOW}`, SECRET, { nowSec: NOW })).toBe(false); // no v1
    expect(verifyStripeSignature(payload, sign(payload), "", { nowSec: NOW })).toBe(false); // no secret
  });

  test("accepts when ONE of several v1 signatures matches (secret rotation)", () => {
    const good = createHmac("sha256", SECRET).update(`${NOW}.${payload}`).digest("hex");
    const header = `t=${NOW},v1=deadbeef,v1=${good}`;
    expect(verifyStripeSignature(payload, header, SECRET, { nowSec: NOW })).toBe(true);
  });
});

describe("constructStripeEvent", () => {
  test("verifies + parses a well-formed event", () => {
    const payload = '{"id":"evt_9","type":"invoice.paid","data":{"object":{"id":"in_1"}}}';
    const event = constructStripeEvent(payload, sign(payload), SECRET, { nowSec: NOW });
    expect(event).toMatchObject({ id: "evt_9", type: "invoice.paid", data: { object: { id: "in_1" } } });
  });

  test("throws on a bad signature", () => {
    const payload = '{"id":"evt_9","type":"invoice.paid","data":{"object":{}}}';
    expect(() => constructStripeEvent(payload, sign(payload, "wrong"), SECRET, { nowSec: NOW })).toThrow(/invalid Stripe webhook signature/);
  });

  test("throws on a validly-signed but non-JSON / malformed body", () => {
    const notJson = "totally not json";
    expect(() => constructStripeEvent(notJson, sign(notJson), SECRET, { nowSec: NOW })).toThrow(/not valid JSON/);
    const noType = '{"id":"evt_9","data":{"object":{}}}';
    expect(() => constructStripeEvent(noType, sign(noType), SECRET, { nowSec: NOW })).toThrow(/well-formed/);
  });
});

describe("stripeEventToAction", () => {
  const ev = (type: string, object: Record<string, unknown>, id = "evt_x"): StripeWebhookEvent => ({ id, type, data: { object } });

  test("invoice.paid → a paid payment with org_id + amount_paid", () => {
    const a = stripeEventToAction(ev("invoice.paid", { id: "in_42", amount_paid: 9900, metadata: { org_id: "org-7" } }));
    expect(a).toEqual({ kind: "payment", status: "paid", stripeInvoiceId: "in_42", orgId: "org-7", amountCents: 9900, eventId: "evt_x", eventType: "invoice.paid" });
  });

  test("invoice.payment_succeeded is also treated as paid", () => {
    const a = stripeEventToAction(ev("invoice.payment_succeeded", { id: "in_1", amount_paid: 100, metadata: { org_id: "o" } }));
    expect(a).toMatchObject({ kind: "payment", status: "paid" });
  });

  test("invoice.payment_failed → a failed payment (amount_due)", () => {
    const a = stripeEventToAction(ev("invoice.payment_failed", { id: "in_2", amount_due: 5000, metadata: { org_id: "o" } }));
    expect(a).toMatchObject({ kind: "payment", status: "failed", amountCents: 5000 });
  });

  test("missing metadata.org_id → orgId null (route will ack but not persist)", () => {
    const a = stripeEventToAction(ev("invoice.paid", { id: "in_3", amount_paid: 1 }));
    expect(a).toMatchObject({ kind: "payment", orgId: null });
  });

  test("an unrelated event type is ignored", () => {
    expect(stripeEventToAction(ev("customer.created", { id: "cus_1" }))).toEqual({ kind: "ignore", eventType: "customer.created" });
  });
});
