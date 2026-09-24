// Unit tests for the invoice ledger seam (record-on-send + period dedup). The SQL shape is verified
// against a minimal fake Supabase client (no DB); the DB partial-unique-index backstop is exercised live.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimAndFinalizeInvoice, createSupabaseInvoiceLedger, reconcileClaimedInvoice, inspectClaimedInvoice, type InvoiceLedger } from "../../src/billing/invoice-ledger";
import type { Invoice } from "../../src/types/billing";

interface FakeOpts {
  selectResult?: { data?: unknown[] | null; error?: { message: string } | null };
  insertResult?: { error?: { message: string; code?: string } | null };
  rpcResult?: { error?: { message: string } | null };
}
function fakeClient(opts: FakeOpts = {}): {
  client: SupabaseClient;
  calls: { from: string[]; eq: [string, unknown][]; neq: [string, unknown][]; inserted: Record<string, unknown>[]; rpc: Array<{ name: string; args: Record<string, unknown> }> };
} {
  const calls = {
    from: [] as string[],
    eq: [] as [string, unknown][],
    neq: [] as [string, unknown][],
    inserted: [] as Record<string, unknown>[],
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };
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
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      return Promise.resolve(opts.rpcResult ?? { error: null });
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

test("hasClaim reads only the exact organization and period", async () => {
  const { client, calls } = fakeClient({ selectResult: { data: [{ org_id: "org1" }], error: null } });
  expect(await createSupabaseInvoiceLedger(client).hasClaim("org1", "2026-05-01", "2026-06-01")).toBe(true);
  expect(calls.from).toEqual(["invoice_send_claims"]);
  expect(calls.eq).toEqual([
    ["org_id", "org1"],
    ["period_start", "2026-05-01"],
    ["period_end", "2026-06-01"],
  ]);
});

test("recordReconciled persists verified paid state and timestamp", async () => {
  const { client, calls } = fakeClient();
  await createSupabaseInvoiceLedger(client).recordReconciled("org1", {
    stripeInvoiceId: "in_9",
    amountCents: 100,
    currency: "usd",
    periodStart: "2026-05-01",
    periodEnd: "2026-06-01",
    status: "paid",
    paidAt: "2023-11-14T22:13:20.000Z",
  });
  expect(calls.inserted).toHaveLength(0);
  expect(calls.rpc).toEqual([
    {
      name: "reconcile_claimed_invoice",
      args: { p_org_id: "org1", p_stripe_invoice_id: "in_9", p_amount_cents: 100, p_status: "paid", p_period_start: "2026-05-01", p_period_end: "2026-06-01", p_paid_at: "2023-11-14T22:13:20.000Z" },
    },
  ]);
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

test("inspection requires a held claim before provider access", async () => {
  const { client } = fakeClient();
  let providerCalled = false;
  await expect(
    inspectClaimedInvoice(
      createSupabaseInvoiceLedger(client),
      async () => {
        providerCalled = true;
        return {};
      },
      "org1",
      "2026-05-01",
      "2026-06-01",
    ),
  ).rejects.toThrow(/existing period claim/);
  expect(providerCalled).toBe(false);
});

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
      hasClaim: async () => true,
      recordSent: async () => {
        calls.push("record");
      },
      recordReconciled: async () => {},
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
      hasClaim: async () => true,
      recordSent: async () => {
        calls.push("record");
        throw new Error("database unavailable");
      },
      recordReconciled: async () => {},
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

describe("reconcileClaimedInvoice", () => {
  const verified = { id: "in_9", status: "paid" as const, amountUsd: 1, paidAt: "2023-11-14T22:13:20.000Z" };

  test("requires a held claim and refuses a conflicting local invoice before Stripe lookup", async () => {
    const calls: string[] = [];
    const ledger: InvoiceLedger = {
      claimPeriod: async () => true,
      hasClaim: async () => false,
      findActiveForPeriod: async () => {
        calls.push("local");
        return null;
      },
      recordSent: async () => {},
      recordReconciled: async () => {
        calls.push("record");
      },
    };
    await expect(
      reconcileClaimedInvoice(
        ledger,
        async () => {
          calls.push("stripe");
          return verified;
        },
        "org1",
        "2026-05-01",
        "2026-06-01",
        "in_9",
        INVOICE,
      ),
    ).rejects.toThrow(/claim/i);
    expect(calls).toEqual([]);
    ledger.hasClaim = async () => true;
    ledger.findActiveForPeriod = async () => ({ stripe_invoice_id: "in_other", status: "sent" });
    await expect(
      reconcileClaimedInvoice(
        ledger,
        async () => {
          calls.push("stripe");
          return verified;
        },
        "org1",
        "2026-05-01",
        "2026-06-01",
        "in_9",
        INVOICE,
      ),
    ).rejects.toThrow(/different.*invoice/i);
    expect(calls).toEqual([]);
  });

  test("records verified paid state idempotently and keeps the claim on replay", async () => {
    const calls: string[] = [];
    let active: { stripe_invoice_id: string; status: string } | null = null;
    const ledger: InvoiceLedger = {
      claimPeriod: async () => true,
      hasClaim: async () => true,
      findActiveForPeriod: async () => active,
      recordSent: async () => {},
      recordReconciled: async (_org, row) => {
        calls.push(`${row.stripeInvoiceId}:${row.status}:${row.paidAt}`);
        active = { stripe_invoice_id: row.stripeInvoiceId, status: row.status };
      },
    };
    await expect(reconcileClaimedInvoice(ledger, async () => verified, "org1", "2026-05-01", "2026-06-01", "in_9", INVOICE)).resolves.toEqual(verified);
    await expect(reconcileClaimedInvoice(ledger, async () => verified, "org1", "2026-05-01", "2026-06-01", "in_9", INVOICE)).resolves.toEqual(verified);
    expect(calls).toEqual(["in_9:paid:2023-11-14T22:13:20.000Z", "in_9:paid:2023-11-14T22:13:20.000Z"]);
  });

  test("promotes a same-ID local sent row when Stripe verifies payment", async () => {
    const writes: string[] = [];
    const ledger: InvoiceLedger = {
      claimPeriod: async () => true,
      hasClaim: async () => true,
      findActiveForPeriod: async () => ({ stripe_invoice_id: "in_9", status: "sent" }),
      recordSent: async () => {},
      recordReconciled: async (_org, row) => {
        writes.push(`${row.stripeInvoiceId}:${row.status}`);
      },
    };
    await expect(reconcileClaimedInvoice(ledger, async () => verified, "org1", "2026-05-01", "2026-06-01", "in_9", INVOICE)).resolves.toEqual(verified);
    expect(writes).toEqual(["in_9:paid"]);
  });
});
