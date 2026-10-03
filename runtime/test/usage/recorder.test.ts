// specs/ops/payment-removal.md#REQ-4: unsigned writes and input-bound replay.
import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordUsage, type UsageInput } from "../../src/usage/recorder";

const INPUT: UsageInput = {
  sessionId: "s1", orgId: "o1", usageEventId: "00000000-0000-4000-8000-000000000123",
  originalTokens: 50_000, quarantinedTokens: 7_500, apiPricePerToken: 0.000015, pruningLogId: "pl1",
};
const ROW = {
  id: "record-1", session_id: INPUT.sessionId, org_id: INPUT.orgId, usage_event_id: INPUT.usageEventId,
  original_tokens: INPUT.originalTokens, quarantined_tokens: INPUT.quarantinedTokens,
  api_price_per_token: INPUT.apiPricePerToken, pruning_log_id: INPUT.pruningLogId,
};
interface Result { data: unknown; error: { code?: string; message: string } | null }
const DUPLICATE: Result = { data: null, error: { code: "23505", message: "duplicate event" } };

function fakeClient(insertResult: Result = { data: [{ id: ROW.id }], error: null }, replayResult: Result = { data: [ROW], error: null }): {
  client: SupabaseClient; writes: Record<string, unknown>[]; filters: Array<[string, unknown]>; signals: AbortSignal[]; lookups: string[];
} {
  const writes: Record<string, unknown>[] = [];
  const filters: Array<[string, unknown]> = [];
  const signals: AbortSignal[] = [];
  const lookups: string[] = [];
  const result = (value: Result) => Object.assign(Promise.resolve(value), {
    abortSignal(signal: AbortSignal) { signals.push(signal); return Promise.resolve(value); },
  });
  const client = { from(table: string) {
    expect(table).toBe("billing_records");
    return {
      insert(row: Record<string, unknown>) { writes.push(row); return { select: () => ({ limit: () => result(insertResult) }) }; },
      select(columns: string) {
        lookups.push(columns);
        return { eq(column: string, value: unknown) { filters.push([column, value]); return { limit: () => result(replayResult) }; } };
      },
    };
  } } as unknown as SupabaseClient;
  return { client, writes, filters, signals, lookups };
}

describe("unsigned usage recorder — specs/ops/payment-removal.md#AC-4", () => {
  test("writes exact token, price, provenance and event inputs without payment/generated fields", async () => {
    const { client, writes } = fakeClient();
    expect(await recordUsage({ client }, INPUT)).toEqual({ id: ROW.id });
    const { id: _id, ...storedInputs } = ROW;
    expect(writes).toEqual([storedInputs]);
    expect(writes[0]).not.toHaveProperty("signed_hash");
    expect(writes[0]).not.toHaveProperty("cq_fee_usd");
    expect(writes[0]).not.toHaveProperty("token_delta");
    expect(writes[0]).not.toHaveProperty("cost_delta_usd");
  });

  test("omits absent optional provenance and legacy event identity", async () => {
    const { client, writes } = fakeClient();
    const { pruningLogId: _pruning, usageEventId: _event, ...input } = INPUT;
    await recordUsage({ client }, input);
    expect(writes[0]).not.toHaveProperty("pruning_log_id");
    expect(writes[0]).not.toHaveProperty("usage_event_id");
  });

  test("returns the durable ID on identical replay and looks up its event identity", async () => {
    const { client, filters, lookups } = fakeClient(DUPLICATE);
    expect(await recordUsage({ client }, INPUT)).toEqual({ id: ROW.id });
    expect(filters).toEqual([["usage_event_id", INPUT.usageEventId]]);
    expect(lookups[0]?.split(",")).toEqual(expect.arrayContaining(Object.keys(ROW)));
  });

  test.each([
    ["org_id", "other-org"], ["session_id", "other-session"], ["original_tokens", 50_001],
    ["quarantined_tokens", 7_501], ["usage_event_id", "other-event"],
    ["pruning_log_id", "other-pruning-log"], ["pruning_log_id", null], ["api_price_per_token", 0.000016],
  ])("refuses an event replay with different %s inputs", async (column, value) => {
    const { client } = fakeClient(DUPLICATE, { data: [{ ...ROW, [column as string]: value }], error: null });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow(/replay mismatch/);
  });

  test("matches the database null for absent pruning provenance", async () => {
    const { pruningLogId: _pruning, ...input } = INPUT;
    const { client } = fakeClient(DUPLICATE, { data: [{ ...ROW, pruning_log_id: null }], error: null });
    expect(await recordUsage({ client }, input)).toEqual({ id: ROW.id });
  });

  test.each([
    [0.000015, "0.00001500"], [0.000015, 0.000015], [1.5e-8, "0.00000002"],
    [0.000001005, "0.00000101"], [1.000000005, "1.00000001"],
    [0.000003004, "0.00000300"], [0.000003006, "0.00000301"],
    [0.1 + 0.2, "0.30000000"],
  ])("accepts NUMERIC(12,8) round-trip price %s stored as %s", async (price, storedPrice) => {
    const { client } = fakeClient(DUPLICATE, { data: [{ ...ROW, api_price_per_token: storedPrice }], error: null });
    expect(await recordUsage({ client }, { ...INPUT, apiPricePerToken: price as number })).toEqual({ id: ROW.id });
  });

  test.each([null, undefined, "", " ", "not-a-price", "Infinity", {}, 0, -1])("refuses malformed replay price %s", async (price) => {
    const { client } = fakeClient(DUPLICATE, { data: [{ ...ROW, api_price_per_token: price }], error: null });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow(/replay mismatch/);
  });

  test.each([null, [], [{}], [{ id: "" }], [{ id: "  " }], [{ id: null }], [{ id: 1 }]])("refuses unconfirmed insert result %j", async (data) => {
    const { client } = fakeClient({ data, error: null });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow(/no id/);
  });

  test.each([null, [], [{}], [{ ...ROW, id: "" }], [{ ...ROW, id: null }], [{ ...ROW, original_tokens: "50000" }]])("refuses missing or malformed replay row %j", async (data) => {
    const { client } = fakeClient(DUPLICATE, { data, error: null });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow(/replay mismatch/);
  });

  test("preserves insert failures without making an unrelated replay lookup", async () => {
    const { client, lookups } = fakeClient({ data: null, error: { code: "23503", message: "foreign key" } });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow("recordUsage failed: foreign key");
    expect(lookups).toEqual([]);
  });

  test("does not treat a unique conflict without an event identity as a replay", async () => {
    const { usageEventId: _event, ...input } = INPUT;
    const { client, lookups } = fakeClient(DUPLICATE);
    await expect(recordUsage({ client }, input)).rejects.toThrow("recordUsage failed: duplicate event");
    expect(lookups).toEqual([]);
  });

  test("preserves replay lookup errors", async () => {
    const { client } = fakeClient(DUPLICATE, { data: null, error: { message: "database unavailable" } });
    await expect(recordUsage({ client }, INPUT)).rejects.toThrow("recordUsage replay lookup failed: database unavailable");
  });

  test("shares the same abort signal between insert and replay lookup", async () => {
    const { client, signals } = fakeClient(DUPLICATE);
    const signal = new AbortController().signal;
    expect(await recordUsage({ client, signal }, INPUT)).toEqual({ id: ROW.id });
    expect(signals).toEqual([signal, signal]);
  });

  test.each(["originalTokens", "quarantinedTokens", "apiPricePerToken"] as const)("retains finite/nonnegative %s input validation without the fee calculator", async (field) => {
    const { client, writes } = fakeClient();
    for (const value of [-1, Infinity, NaN]) {
      await expect(recordUsage({ client }, { ...INPUT, [field]: value })).rejects.toThrow(/non-negative finite/);
    }
    expect(writes).toEqual([]);
  });
});
