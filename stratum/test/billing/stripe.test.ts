// Unit tests for the Stripe invoice flow (injected fetch). Verifies request construction —
// especially USD→cents — the multi-step ordering, error handling, and the live-key guard.
// What this CAN'T verify is real Stripe acceptance; that's gated on a test-mode key.

import { describe, test, expect } from "vitest";
import type { Invoice } from "../../src/types/billing";
import { usdToCents, encodeForm, sendStripeInvoice, verifyStripeInvoiceForReconciliation, inspectClaimedStripeInvoice, type StripeFetch } from "../../src/billing/stripe";

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
function fakeStripe(
  opts: {
    errorAt?: string;
    existingCustomer?: string;
    existingPendingItem?: boolean;
    existingPendingAmount?: number;
    pendingPages?: unknown[];
    invoicePages?: unknown[];
    draftAmount?: number;
    finalAmount?: number;
  } = {},
): {
  doFetch: StripeFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let pendingPage = 0;
  let invoicePage = 0;
  let createdAmount = 0;
  const doFetch: StripeFetch = (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers, method: init.method });
    if (opts.errorAt !== undefined && url.includes(opts.errorAt)) {
      return Promise.resolve({ status: 402, json: () => Promise.resolve({ error: { message: "card_declined" } }) });
    }
    let json: unknown = {};
    if (url.includes("/v1/customers/search")) json = { has_more: false, data: opts.existingCustomer !== undefined ? [{ id: opts.existingCustomer }] : [] };
    else if (url.endsWith("/finalize")) json = { id: url.split("/").at(-2), status: "open", amount_due: opts.finalAmount ?? createdAmount, total: opts.finalAmount ?? createdAmount, currency: "usd" };
    else if (url.includes("/v1/customers")) json = { id: "cus_1" };
    // GET = the pending-item idempotency pre-check (>24h double-charge guard); POST = create the item.
    else if (url.includes("/v1/invoiceitems") && init.method === "GET")
      json = opts.pendingPages?.[pendingPage++] ?? {
        has_more: false,
        data: opts.existingPendingItem
          ? [{ id: "ii_existing", amount: opts.existingPendingAmount ?? 6304, currency: "usd", metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } }]
          : [],
      };
    else if (url.includes("/v1/invoiceitems")) json = { id: "ii_1" };
    else if (url.includes("/v1/invoices") && init.method === "GET") json = opts.invoicePages?.[invoicePage++] ?? { has_more: false, data: [] };
    else if (url.includes("/v1/invoices")) {
      createdAmount = new URLSearchParams(init.body).get("pending_invoice_items_behavior") === "include" ? (opts.draftAmount ?? 6304) : 0;
      json = { id: "in_1", status: "draft", amount_due: createdAmount, total: createdAmount, currency: "usd" };
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve(json) });
  };
  return { doFetch, calls };
}

/** The path (no query) of each call, in order. */
const paths = (calls: Call[]): string[] => calls.map((c) => c.url.replace("https://api.stripe.com", "").split("?")[0]!);

describe("inspectClaimedStripeInvoice", () => {
  test("reads a later customer page and reports an exact invoice without a POST", async () => {
    const calls: Call[] = [];
    const doFetch: StripeFetch = async (url, init) => {
      calls.push({ url, ...init });
      if (url.includes("/customers/search"))
        return {
          status: 200,
          json: async () => (new URL(url).searchParams.has("page") ? { has_more: false, data: [{ id: "cus_later" }] } : { has_more: true, next_page: "next", data: [{ id: "cus_first" }] }),
        };
      if (url.includes("/invoices?"))
        return {
          status: 200,
          json: async () => ({
            has_more: false,
            data: url.includes("cus_later")
              ? [{ id: "in_found", status: "open", total: 6304, amount_due: 6304, currency: "usd", metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } }]
              : [],
          }),
        };
      return { status: 200, json: async () => ({ has_more: false, data: [] }) };
    };
    expect(await inspectClaimedStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).toEqual({ invoiceId: "in_found", status: "open", pendingItemId: undefined });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.includes("page=next"))).toBe(true);
  });

  test("empty search is inconclusive and makes no Stripe write", async () => {
    const { doFetch, calls } = fakeStripe();
    expect(await inspectClaimedStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).toEqual({ invoiceId: undefined, status: undefined, pendingItemId: undefined });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("reports a pending matching item while ignoring an unrelated item", async () => {
    const { doFetch, calls } = fakeStripe({
      existingCustomer: "cus_existing",
      pendingPages: [
        {
          has_more: false,
          data: [
            { id: "ii_other", metadata: { org_id: "other" } },
            { id: "ii_match", amount: 6304, currency: "usd", metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } },
          ],
        },
      ],
    });
    expect(await inspectClaimedStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).toEqual({ invoiceId: undefined, status: undefined, pendingItemId: "ii_match" });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("refuses malformed customer pagination rather than claiming a complete lookup", async () => {
    const doFetch: StripeFetch = async (url) => ({
      status: 200,
      json: async () => (url.includes("/customers/search") ? { has_more: true, data: [{ id: "cus_one" }] } : { has_more: false, data: [] }),
    });
    await expect(inspectClaimedStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/customer search.*cursor/);
  });
});

describe("sendStripeInvoice", () => {
  const billedInvoice = (id: string, status: string, amount = 6304) => ({
    id,
    status,
    total: amount,
    amount_due: amount,
    currency: "usd",
    metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" },
  });

  test("search → create customer → invoice-item (amount in CENTS) → invoice → finalize, and returns the receipt", async () => {
    const { doFetch, calls } = fakeStripe();
    const receipt = await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);

    expect(paths(calls)).toEqual([
      "/v1/customers/search", // lookup-or-create: search by org_id metadata first
      "/v1/customers", // not found → create
      "/v1/invoices", // GET: exact-period invoice retry lookup
      "/v1/invoiceitems", // GET: pending-item idempotency pre-check (>24h double-charge guard)
      "/v1/invoiceitems", // POST: create the item
      "/v1/invoices",
      "/v1/invoices/in_1/finalize",
    ]);
    const item = new URLSearchParams(calls.find((call) => call.url.endsWith("/v1/invoiceitems") && call.method === "POST")!.body);
    expect(item.get("amount")).toBe("6304"); // $63.04 → 6304 cents (NOT 63 or 6304.0)
    expect(item.get("currency")).toBe("usd");
    expect(item.get("customer")).toBe("cus_1");
    expect(item.get("metadata[period_start]")).toBe("2026-04"); // period+org metadata enables the >24h idempotency lookup
    expect(item.get("metadata[org_id]")).toBe("o1");
    const invoiceBody = new URLSearchParams(calls.find((call) => call.url.endsWith("/v1/invoices") && call.method === "POST")!.body);
    expect(invoiceBody.get("pending_invoice_items_behavior")).toBe("include");
    expect(invoiceBody.get("metadata[period_start]")).toBe("2026-04");
    expect(invoiceBody.get("metadata[period_end]")).toBe("(now)");
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
    expect(paths(calls)).toEqual(["/v1/customers/search", "/v1/invoices", "/v1/invoiceitems", "/v1/invoiceitems", "/v1/invoices", "/v1/invoices/in_1/finalize"]);
    expect(paths(calls)).not.toContain("/v1/customers"); // create skipped
    expect(new URLSearchParams(calls.find((call) => call.url.endsWith("/v1/invoiceitems") && call.method === "POST")!.body).get("customer")).toBe("cus_existing");
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
    expect(paths(calls)).toEqual(["/v1/customers/search", "/v1/invoices", "/v1/invoiceitems", "/v1/invoices", "/v1/invoices/in_1/finalize"]);
  });

  test("returns an existing period invoice on page two without creating Stripe state", async () => {
    const first = Array.from({ length: 100 }, (_, i) => billedInvoice(`in_other_${i}`, "open"));
    first.forEach((entry) => {
      entry.metadata.period_start = "2026-03";
    });
    const { doFetch, calls } = fakeStripe({
      existingCustomer: "cus_existing",
      invoicePages: [
        { has_more: true, data: first },
        { has_more: false, data: [billedInvoice("in_existing", "open")] },
      ],
    });
    const receipt = await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);
    expect(receipt).toEqual({ id: "in_existing", status: "open", amountUsd: 63.04 });
    const gets = calls.filter((call) => call.url.includes("/v1/invoices?") && call.method === "GET");
    expect(gets).toHaveLength(2);
    expect(new URL(gets[1]!.url).searchParams.get("starting_after")).toBe("in_other_99");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("finalizes an existing draft for the period without creating another item", async () => {
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", finalAmount: 6304, invoicePages: [{ has_more: false, data: [billedInvoice("in_existing", "draft")] }] });
    const receipt = await sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE);
    expect(receipt.id).toBe("in_existing");
    expect(paths(calls)).toContain("/v1/invoices/in_existing/finalize");
    expect(calls.filter((call) => call.url.includes("/v1/invoiceitems"))).toHaveLength(0);
  });

  test("refuses a mismatched or duplicate period invoice before creating another", async () => {
    for (const data of [[billedInvoice("in_wrong", "open", 6303)], [billedInvoice("in_a", "open"), billedInvoice("in_b", "open")]]) {
      const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", invoicePages: [{ has_more: false, data }] });
      await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/existing.*invoice|multiple.*invoice/i);
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    }
  });

  test("refuses an untagged legacy Stratum invoice before creating another", async () => {
    const legacy = { ...billedInvoice("in_legacy", "open"), metadata: { org_id: "o1" } };
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", invoicePages: [{ has_more: false, data: [legacy] }] });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/legacy.*period/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses a repeated invoice pagination cursor before creating another", async () => {
    const other = { ...billedInvoice("in_repeated", "open"), metadata: { org_id: "other" } };
    const { doFetch, calls } = fakeStripe({
      existingCustomer: "cus_existing",
      invoicePages: [
        { has_more: true, data: [other] },
        { has_more: true, data: [other] },
      ],
    });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/invoice.*cursor/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses a malformed invoice list before creating another", async () => {
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", invoicePages: [{ data: [] }] });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/invoice list.*invalid page/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("scans a second pending page but refuses to sweep unrelated items", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `ii_${i}`, metadata: { org_id: "other" } }));
    const match = { id: "ii_existing", amount: 6304, currency: "usd", metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } };
    const { doFetch, calls } = fakeStripe({
      existingCustomer: "cus_existing",
      pendingPages: [
        { has_more: true, data: first },
        { has_more: false, data: [match] },
      ],
    });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/another pending invoice item/i);
    const gets = calls.filter((call) => call.url.includes("/v1/invoiceitems") && call.method === "GET");
    expect(gets).toHaveLength(2);
    expect(new URL(gets[1]!.url).searchParams.get("starting_after")).toBe("ii_99");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses an incomplete pending-item page before creating Stripe state", async () => {
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", pendingPages: [{ has_more: true, data: [] }] });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/pending invoice items|cursor/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses a repeated pagination cursor before creating Stripe state", async () => {
    const repeated = { id: "ii_repeated", metadata: { org_id: "other" } };
    const { doFetch, calls } = fakeStripe({
      existingCustomer: "cus_existing",
      pendingPages: [
        { has_more: true, data: [repeated] },
        { has_more: true, data: [repeated] },
      ],
    });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/pending invoice items.*cursor/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses to create an item when the pending-item scan reaches its page bound", async () => {
    const pendingPages = Array.from({ length: 100 }, (_, i) => ({ has_more: true, data: [{ id: `ii_${i}`, metadata: { org_id: "other" } }] }));
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", pendingPages });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/scan exceeded 100 pages/);
    expect(calls.filter((call) => call.url.includes("/v1/invoiceitems") && call.method === "GET")).toHaveLength(100);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses to reuse a pending item whose amount differs from the current invoice", async () => {
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", existingPendingItem: true, existingPendingAmount: 6303 });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/pending invoice item.*amount/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refuses to reuse a pending item without an explicit USD currency", async () => {
    const pending = { id: "ii_existing", amount: 6304, metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" } };
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", pendingPages: [{ has_more: false, data: [pending] }] });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/pending invoice item.*currency/i);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("does not sweep another period's pending item into the invoice", async () => {
    const unrelated = { id: "ii_other", amount: 2500, currency: "usd", metadata: { org_id: "o1", period_start: "2026-03", period_end: "2026-04" } };
    const { doFetch, calls } = fakeStripe({ existingCustomer: "cus_existing", pendingPages: [{ has_more: false, data: [unrelated] }] });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/other pending invoice item/i);
    expect(calls.filter((call) => call.url.includes("/v1/invoices") && call.method === "POST")).toHaveLength(0);
  });

  test("refuses an empty draft invoice before finalization", async () => {
    const { doFetch, calls } = fakeStripe({ draftAmount: 0 });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/draft invoice amount/i);
    expect(paths(calls)).not.toContain("/v1/invoices/in_1/finalize");
  });

  test("refuses a finalized invoice whose amount changed", async () => {
    const { doFetch } = fakeStripe({ finalAmount: 0 });
    await expect(sendStripeInvoice({ secretKey: "sk_test_x", doFetch }, INVOICE)).rejects.toThrow(/finalized invoice amount/i);
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

describe("verifyStripeInvoiceForReconciliation", () => {
  const billed = () => ({
    id: "in_existing",
    object: "invoice",
    status: "paid",
    total: 6304,
    amount_due: 6304,
    currency: "usd",
    metadata: { org_id: "o1", period_start: "2026-04", period_end: "(now)" },
    status_transitions: { paid_at: 1_700_000_000 },
  });

  test("retrieves and verifies a paid invoice without any POST", async () => {
    const calls: Call[] = [];
    const doFetch: StripeFetch = (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers, method: init.method });
      return Promise.resolve({ status: 200, json: () => Promise.resolve(billed()) });
    };
    const receipt = await verifyStripeInvoiceForReconciliation({ secretKey: "sk_test_x", doFetch }, "in_existing", INVOICE);
    expect(receipt).toEqual({ id: "in_existing", status: "paid", amountUsd: 63.04, paidAt: "2023-11-14T22:13:20.000Z" });
    expect(paths(calls)).toEqual(["/v1/invoices/in_existing"]);
    expect(calls[0]?.method).toBe("GET");
  });

  test("rejects wrong identity, metadata, amount, draft, or absent paid time", async () => {
    const cases = [
      { ...billed(), id: "in_other" },
      { ...billed(), metadata: { ...billed().metadata, org_id: "other" } },
      { ...billed(), total: 6303 },
      { ...billed(), status: "draft" },
      { ...billed(), status_transitions: {} },
    ];
    for (const body of cases) {
      const doFetch: StripeFetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
      await expect(verifyStripeInvoiceForReconciliation({ secretKey: "sk_test_x", doFetch }, "in_existing", INVOICE)).rejects.toThrow();
    }
  });
});
