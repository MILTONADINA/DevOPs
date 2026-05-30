// Unit tests for the Stripe invoice flow (injected fetch). Verifies request construction —
// especially USD→cents — the multi-step ordering, error handling, and the live-key guard.
// What this CAN'T verify is real Stripe acceptance; that's gated on a test-mode key.

import { describe, test, expect } from "vitest";
import type { Invoice } from "../../src/types/billing";
import { usdToCents, encodeForm, sendStripeInvoice, type StripeFetch } from "../../src/billing/stripe";

describe("usdToCents", () => {
  test("converts dollars to integer cents (the mischarge-risk conversion)", () => {
    expect(usdToCents(63.04)).toBe(6304);
    expect(usdToCents(99)).toBe(9900);
    expect(usdToCents(0.1)).toBe(10);
    expect(usdToCents(0)).toBe(0);
    expect(usdToCents(0.155)).toBe(16); // half-cent rounds up via the epsilon nudge
  });
});

describe("encodeForm", () => {
  test("form-encodes + escapes (incl. metadata[key])", () => {
    expect(encodeForm({ "metadata[org_id]": "a b", amount: 6304 })).toBe("metadata%5Borg_id%5D=a%20b&amount=6304");
  });
});

const INVOICE: Invoice = {
  orgId: "o1",
  plan: "growth",
  periodStart: "2026-04",
  periodEnd: "(now)",
  recordCount: 5,
  totalOriginalTokens: 100_000,
  totalQuarantinedTokens: 15_000,
  totalSavingsUsd: 315.2,
  rawFeeUsd: 63.04,
  monthlyMinimumUsd: 0,
  amountDueUsd: 63.04,
  effectivenessPct: 85,
  lineItems: [],
};

function fakeStripe(opts: { errorAt?: string } = {}): { doFetch: StripeFetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const doFetch: StripeFetch = (url, init) => {
    calls.push({ url, body: init.body });
    if (opts.errorAt !== undefined && url.includes(opts.errorAt)) {
      return Promise.resolve({ status: 402, json: () => Promise.resolve({ error: { message: "card_declined" } }) });
    }
    let json: unknown = {};
    if (url.endsWith("/finalize")) json = { id: "in_1", status: "open" };
    else if (url.includes("/v1/customers")) json = { id: "cus_1" };
    else if (url.includes("/v1/invoiceitems")) json = { id: "ii_1" };
    else if (url.includes("/v1/invoices")) json = { id: "in_1", status: "draft" };
    return Promise.resolve({ status: 200, json: () => Promise.resolve(json) });
  };
  return { doFetch, calls };
}

describe("sendStripeInvoice", () => {
  test("runs customer → invoice-item (amount in CENTS) → invoice → finalize, and returns the receipt", async () => {
    const { doFetch, calls } = fakeStripe();
    const receipt = await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);

    expect(calls.map((c) => c.url.replace("https://api.stripe.com", ""))).toEqual([
      "/v1/customers",
      "/v1/invoiceitems",
      "/v1/invoices",
      "/v1/invoices/in_1/finalize",
    ]);
    const item = new URLSearchParams(calls[1]!.body);
    expect(item.get("amount")).toBe("6304"); // $63.04 → 6304 cents (NOT 63 or 6304.0)
    expect(item.get("currency")).toBe("usd");
    expect(item.get("customer")).toBe("cus_1");
    expect(receipt).toEqual({ id: "in_1", status: "open", amountUsd: 63.04 });
  });

  test("a Stripe API error is surfaced (with the Stripe message), not swallowed", async () => {
    const { doFetch } = fakeStripe({ errorAt: "/v1/invoiceitems" });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/Stripe \/v1\/invoiceitems failed: card_declined/);
  });

  test("empty key → throws (gated)", async () => {
    await expect(sendStripeInvoice({ secretKey: "", doFetch: fakeStripe().doFetch }, INVOICE)).rejects.toThrow(/STRIPE_SECRET_KEY is empty/);
  });

  test("a LIVE key is REFUSED until verified — never fetches", async () => {
    const { doFetch, calls } = fakeStripe();
    await expect(sendStripeInvoice({ secretKey: "sk_live_danger", doFetch }, INVOICE)).rejects.toThrow(/refusing a LIVE Stripe key/);
    expect(calls).toHaveLength(0); // no request was made
  });

  test("a LIVE key WITH allowLiveKey proceeds (explicit opt-in after verification)", async () => {
    const { doFetch, calls } = fakeStripe();
    await sendStripeInvoice({ secretKey: "sk_live_ok", doFetch, allowLiveKey: true }, INVOICE);
    expect(calls.length).toBeGreaterThan(0);
  });
});
