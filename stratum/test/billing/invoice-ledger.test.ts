// Unit tests for the invoice ledger seam (record-on-send + period dedup). The SQL shape is verified
// against a minimal fake Supabase client (no DB); the DB partial-unique-index backstop is exercised live.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseInvoiceLedger } from "../../src/billing/invoice-ledger";

interface FakeOpts {
  selectResult?: { data?: unknown[] | null; error?: { message: string } | null };
  insertResult?: { error?: { message: string } | null };
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

  test("omits the period columns when unbounded (NULL period — excluded from the dedup index)", async () => {
    const { client, calls } = fakeClient();
    await createSupabaseInvoiceLedger(client).recordSent("org1", { stripeInvoiceId: "in_2", amountCents: 100, currency: "usd" });
    expect(calls.inserted[0]).not.toHaveProperty("period_start");
    expect(calls.inserted[0]).not.toHaveProperty("period_end");
    expect(calls.inserted[0]).toMatchObject({ status: "sent", stripe_invoice_id: "in_2" });
  });

  test("throws (fail-loud) on an insert error — incl. the partial-unique-index violation on a duplicate period", async () => {
    const { client } = fakeClient({ insertResult: { error: { message: "duplicate key value violates unique constraint" } } });
    await expect(createSupabaseInvoiceLedger(client).recordSent("o", { stripeInvoiceId: "x", amountCents: 1, currency: "usd" })).rejects.toThrow(/recordSent failed: duplicate key/);
  });
});
