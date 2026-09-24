// Unit tests for the invoice ledger seam (record-on-send + period dedup). The SQL shape is verified
// against a minimal fake Supabase client (no DB); the DB partial-unique-index backstop is exercised live.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimAndFinalizeInvoice, createSupabaseInvoiceLedger, type InvoiceLedger } from "../../src/billing/invoice-ledger";
import type { Invoice } from "../../src/types/billing";

interface FakeOpts {
  selectResult?: { data?: unknown[] | null; error?: { message: string } | null };
  insertResult?: { error?: { message: string; code?: string } | null };
}
function fakeClient(opts: FakeOpts = {}): {
  client: SupabaseClient;
  calls: { from: string[]; eq: [string, unknown][]; neq: [string, unknown][]; inserted: Record<string, unknown>[] };
} {
  const calls = { from: [] as string[], eq: [] as [string, unknown][], neq: [] as [string, unknown][], inserted: [] as Record<string, unknown>[] };
  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.eq.push([col, val]);
      return builder;
    },
    neq(col: string, val: unknown) {
      calls.neq.push([col, val]);
      return builder;
    },
    limit() {
      return Promise.resolve(opts.selectResult ?? { data: [], error: null });
    },
    insert(row: Record<string, unknown>) {
      calls.inserted.push(row);
      return Promise.resolve(opts.insertResult ?? { error: null });
    },
  };
  const client = {
    from(table: string) {
      calls.from.push(table);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("createSupabaseInvoiceLedger — findActiveForPeriod", () => {
  test("returns the blocking invoice + queries the right filters (org, period, non-failed)", async () => {
    const { client, calls } = fakeClient({ selectResult: { data: [{ stripe_invoice_id: "in_9", status: "sent" }], error: null } });
    const got = await createSupabaseInvoiceLedger(client).findActiveForPeriod("org1", "2026-05-01", "2026-06-01");
    expect(got).toEqual({ stripe_invoice_id: "in_9", status: "sent" });
    expect(calls.from).toEqual(["invoices"]);
    expect(calls.eq).toEqual([
      ["org_id", "org1"],
      ["period_start", "2026-05-01"],
      ["period_end", "2026-06-01"],
    ]);
    expect(calls.neq).toEqual([["status", "failed"]]); // a failed invoice does NOT block a re-send
  });

  test("returns null when no active invoice exists for the period", async () => {
    const { client } = fakeClient({ selectResult: { data: [], error: null } });
    expect(await createSupabaseInvoiceLedger(client).findActiveForPeriod("o", "a", "b")).toBeNull();
  });

  test("throws (fail-loud) on a query error", async () => {
    const { client } = fakeClient({ selectResult: { data: null, error: { message: "boom" } } });
    await expect(createSupabaseInvoiceLedger(client).findActiveForPeriod("o", "a", "b")).rejects.toThrow(/findActiveForPeriod failed: boom/);
  });
});

describe("createSupabaseInvoiceLedger — recordSent", () => {
  test("inserts a status='sent' row with the period bounds", async () => {
    const { client, calls } = fakeClient();
    await createSupabaseInvoiceLedger(client).recordSent("org1", { stripeInvoiceId: "in_1", amountCents: 9900, currency: "usd", periodStart: "2026-05-01", periodEnd: "2026-06-01" });
    expect(calls.inserted[0]).toEqual({
      org_id: "org1",
      stripe_invoice_id: "in_1",
      amount_cents: 9900,
      currency: "usd",
      status: "sent",
      period_start: "2026-05-01",
      period_end: "2026-06-01",
    });
  });

  test("throws (fail-loud) on an insert error — incl. the partial-unique-index violation on a duplicate period", async () => {
    const { client } = fakeClient({ insertResult: { error: { message: "duplicate key value violates unique constraint" } } });
    await expect(createSupabaseInvoiceLedger(client).recordSent("o", { stripeInvoiceId: "x", amountCents: 1, currency: "usd", periodStart: "2026-05-01", periodEnd: "2026-06-01" })).rejects.toThrow(
      /recordSent failed: duplicate key/,
    );
  });
});

describe("createSupabaseInvoiceLedger — claimPeriod", () => {
  test("inserts a durable organization/period claim before provider work", async () => {
    const { client, calls } = fakeClient();
    expect(await createSupabaseInvoiceLedger(client).claimPeriod("org1", "2026-05-01", "2026-06-01")).toBe(true);
    expect(calls.from).toEqual(["invoice_send_claims"]);
    expect(calls.inserted).toEqual([{ org_id: "org1", period_start: "2026-05-01", period_end: "2026-06-01" }]);
  });

  test("returns false on a competing claim and throws on other storage errors", async () => {
    const duplicate = fakeClient({ insertResult: { error: { code: "23505", message: "duplicate key" } } });
    expect(await createSupabaseInvoiceLedger(duplicate.client).claimPeriod("org1", "2026-05-01", "2026-06-01")).toBe(false);
    const outage = fakeClient({ insertResult: { error: { message: "database unavailable" } } });
    await expect(createSupabaseInvoiceLedger(outage.client).claimPeriod("org1", "2026-05-01", "2026-06-01")).rejects.toThrow(/claimPeriod failed: database unavailable/);
  });
});

const INVOICE: Invoice = {
  orgId: "org1",
  plan: "growth",
  periodStart: "2026-05-01",
  periodEnd: "2026-06-01",
  recordCount: 1,
  totalOriginalTokens: 100,
  totalQuarantinedTokens: 50,
  totalSavingsUsd: 5,
  rawFeeUsd: 1,
  monthlyMinimumUsd: 0,
  amountDueUsd: 1,
  effectivenessPct: 50,
  lineItems: [],
};

describe("claimAndFinalizeInvoice", () => {
  test("only the winner of a durable period claim can call Stripe", async () => {
    const calls: string[] = [];
    let claimed = false;
    const ledger: InvoiceLedger = {
      claimPeriod: async () => {
        calls.push("claim");
        if (claimed) return false;
        claimed = true;
        return true;
      },
      findActiveForPeriod: async () => null,
      recordSent: async () => {
        calls.push("record");
      },
    };
    const sink = {
      send: async () => {
        calls.push("stripe");
        return { id: "in_1", status: "open", amountUsd: 1 };
      },
    };
    await expect(claimAndFinalizeInvoice(ledger, sink, "org1", "2026-05-01", "2026-06-01", INVOICE)).resolves.toMatchObject({ id: "in_1" });
    await expect(claimAndFinalizeInvoice(ledger, sink, "org1", "2026-05-01", "2026-06-01", INVOICE)).rejects.toThrow(/already claimed/);
    expect(calls).toEqual(["claim", "stripe", "record", "claim"]);
  });

  test("retains the claim and reports the Stripe ID when local recording fails", async () => {
    const calls: string[] = [];
    const ledger: InvoiceLedger = {
      claimPeriod: async () => {
        calls.push("claim");
        return true;
      },
      findActiveForPeriod: async () => null,
      recordSent: async () => {
        calls.push("record");
        throw new Error("database unavailable");
      },
    };
    const sink = {
      send: async () => {
        calls.push("stripe");
        return { id: "in_9", status: "open", amountUsd: 1 };
      },
    };
    await expect(claimAndFinalizeInvoice(ledger, sink, "org1", "2026-05-01", "2026-06-01", INVOICE)).rejects.toThrow(/in_9 finalized but local ledger write failed: database unavailable/);
    expect(calls).toEqual(["claim", "stripe", "record"]);
  });
});
