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

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
  method: string;
}
function fakeStripe(opts: { errorAt?: string; existingCustomer?: string; existingPendingItem?: boolean } = {}): { doFetch: StripeFetch; calls: Call[] } {
  const calls: Call[] = [];
  const doFetch: StripeFetch = (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers, method: init.method });
    if (opts.errorAt !== undefined && url.includes(opts.errorAt)) {
      return Promise.resolve({ status: 402, json: () => Promise.resolve({ error: { message: "card_declined" } }) });
    }
    let json: unknown = {};
    if (url.includes("/v1/customers/search")) json = { data: opts.existingCustomer !== undefined ? [{ id: opts.existingCustomer }] : [] };
    else if (url.endsWith("/finalize")) json = { id: "in_1", status: "open" };
    else if (url.includes("/v1/customers")) json = { id: "cus_1" };
    // GET = the pending-item idempotency pre-check (>24h double-charge guard); POST = create the item.
    else if (url.includes("/v1/invoiceitems") && init.method === "GET") json = { data: opts.existingPendingItem ? [{ id: "ii_existing", metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } }] : [] };
    else if (url.includes("/v1/invoiceitems")) json = { id: "ii_1" };
    else if (url.includes("/v1/invoices")) json = { id: "in_1", status: "draft" };
    return Promise.resolve({ status: 200, json: () => Promise.resolve(json) });
  };
  return { doFetch, calls };
}

/** The path (no query) of each call, in order. */
const paths = (calls: Call[]): string[] => calls.map((c) => c.url.replace("https://api.stripe.com", "").split("?")[0]!);

describe("sendStripeInvoice", () => {
  test("search → create customer → invoice-item (amount in CENTS) → invoice → finalize, and returns the receipt", async () => {
    const { doFetch, calls } = fakeStripe();
    const receipt = await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);

    expect(paths(calls)).toEqual([
      "/v1/customers/search", // lookup-or-create: search by org_id metadata first
      "/v1/customers", // not found → create
      "/v1/invoiceitems", // GET: pending-item idempotency pre-check (>24h double-charge guard)
      "/v1/invoiceitems", // POST: create the item
      "/v1/invoices",
      "/v1/invoices/in_1/finalize",
    ]);
    const item = new URLSearchParams(calls[3]!.body); // calls[2] is now the GET pre-check; the POST is [3]
    expect(item.get("amount")).toBe("6304"); // $63.04 → 6304 cents (NOT 63 or 6304.0)
    expect(item.get("currency")).toBe("usd");
    expect(item.get("customer")).toBe("cus_1");
    expect(item.get("metadata[period_start]")).toBe("2026-04"); // period+org metadata enables the >24h idempotency lookup
    expect(item.get("metadata[org_id]")).toBe("o1");
    expect(receipt).toEqual({ id: "in_1", status: "open", amountUsd: 63.04 });
  });

  test("every mutating POST carries a deterministic Idempotency-Key (retry → no duplicate charge)", async () => {
    const { doFetch, calls } = fakeStripe();
    await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);
    const keyFor = (pathPart: string): string | undefined => calls.find((c) => c.url.includes(pathPart) && c.method === "POST")?.headers["idempotency-key"];
    expect(keyFor("/v1/customers")).toBe("stratum-customer-o1"); // org-scoped (period-independent)
    expect(keyFor("/v1/invoiceitems")).toBe("o1|2026-04|(now)|invoiceitem"); // org+period scoped
    expect(keyFor("/v1/invoices")).toBe("o1|2026-04|(now)|invoice");
    expect(calls.find((c) => c.url.endsWith("/finalize"))?.headers["idempotency-key"]).toBe("o1|2026-04|(now)|finalize");
    // the search is a GET and carries no idempotency key
    expect(calls.find((c) => c.url.includes("/v1/customers/search"))?.method).toBe("GET");
  });

  test("an EXISTING customer is reused (no duplicate customer created on re-run)", async () => {
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing" });
    await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);
    expect(paths(calls)).toEqual(["/v1/customers/search", "/v1/invoiceitems", "/v1/invoiceitems", "/v1/invoices", "/v1/invoices/in_1/finalize"]);
    expect(paths(calls)).not.toContain("/v1/customers"); // create skipped
    expect(new URLSearchParams(calls[2]!.body).get("customer")).toBe("cus_existing"); // POST item is now index 2 (after the GET pre-check)
  });

  test("a $0 amount-due is refused BEFORE any Stripe call (no orphaned customer)", async () => {
    const { doFetch, calls } = fakeStripe();
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, { ...INVOICE, amountDueUsd: 0 })).rejects.toThrow(/nothing to charge/);
    expect(calls).toHaveLength(0); // not even the customer search ran
  });

  test("a Stripe API error is surfaced (with the Stripe message), not swallowed", async () => {
    const { doFetch } = fakeStripe({ errorAt: "/v1/invoiceitems" });
    // (.* tolerates the query string on the pending-item GET, which is the first /v1/invoiceitems call.)
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/Stripe \/v1\/invoiceitems.*failed: card_declined/);
  });

  test("reuses an existing pending invoice item for the same org+period — no duplicate (>24h double-charge guard)", async () => {
    // Simulates a prior run that created the invoice item but crashed before the invoice swept it up;
    // >24h later Stripe's Idempotency-Key no longer dedups, so without this guard a SECOND item would be
    // created and the invoice would bill BOTH. The pending-item GET matches on org+period metadata → skip.
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", existingPendingItem: true });
    await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);
    const itemPosts = calls.filter((c) => c.url.includes("/v1/invoiceitems") && c.method === "POST");
    expect(itemPosts).toHaveLength(0); // no new item created — the existing pending item is reused
    expect(paths(calls)).toEqual(["/v1/customers/search", "/v1/invoiceitems", "/v1/invoices", "/v1/invoices/in_1/finalize"]);
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
