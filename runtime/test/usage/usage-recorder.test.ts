// specs/ops/payment-removal.md#REQ-5: preserve usage buckets and estimates without signing.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseUsageRecorder } from "../../src/usage/usage-recorder";

interface Insert {
  table: string;
  row: Record<string, unknown>;
}

function fakeClient(): { client: SupabaseClient; inserts: Insert[] } {
  const inserts: Insert[] = [];
  let session = 0;
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          const id = table === "sessions" ? `sess-${++session}` : `rec-${inserts.length}`;
          const result = { data: [{ id }], error: null };
          return { select: () => ({ limit: () => Promise.resolve(result) }) };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts };
}

const NOW = Date.UTC(2026, 4, 30, 12, 0, 0); // fixed → one UTC-day bucket

describe("createSupabaseUsageRecorder", () => {
  test("records an unsigned, honest 0-savings usage record (original == quarantined) — specs/ops/payment-removal.md#AC-5", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW, priceFn: () => 0.000003 });
    await rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });

    const session = inserts.find((i) => i.table === "sessions");
    const billing = inserts.find((i) => i.table === "billing_records");
    expect(session?.row).toEqual({ org_id: "org-1", project_scope: null, model: "claude-sonnet-4-6", kind: "usage" }); // PB-46: a usage bucket, not an explicit session
    expect(billing?.row).toMatchObject({ org_id: "org-1", session_id: "sess-1", original_tokens: 8000, quarantined_tokens: 8000, api_price_per_token: 0.000003 });

    expect(billing?.row).not.toHaveProperty("signed_hash");
    expect(billing?.row).not.toHaveProperty("cq_fee_usd");
  });

  test("passes an event UUID through to the unsigned row", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    const eventId = "00000000-0000-4000-8000-000000000123";
    await rec.recordUsage({ orgId: "org-1", eventId, model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });
    const row = inserts.find((i) => i.table === "billing_records")?.row;
    expect(row?.["usage_event_id"]).toBe(eventId);
    expect(row).not.toHaveProperty("signed_hash");
  });

  test("a replay after midnight keeps the original usage bucket day", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW + 86_400_000 });
    const occurredAt = new Date(NOW).toISOString();
    await rec.recordUsage({ orgId: "org-1", eventId: "00000000-0000-4000-8000-000000000123", occurredAt, model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });
    expect(inserts.find((i) => i.table === "sessions")?.row["created_at"]).toBe(occurredAt);
  });

  test("uses the price pinned by the outbox instead of a later model price", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, priceFn: () => 9 });
    await rec.recordUsage({ orgId: "org-1", eventId: "00000000-0000-4000-8000-000000000123", occurredAt: new Date(NOW).toISOString(), apiPricePerToken: 0.000003, model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });
    expect(inserts.find((i) => i.table === "billing_records")?.row["api_price_per_token"]).toBe(0.000003);
  });

  test("bounds the session and ledger requests with one per-event abort signal", async () => {
    const signals: AbortSignal[] = [];
    const client = {
      from(table: string) {
        return { insert: () => ({ select: () => ({ limit: () => ({ abortSignal: (signal: AbortSignal) => {
          signals.push(signal);
          return Promise.resolve({ data: [{ id: table === "sessions" ? "sess-1" : "rec-1" }], error: null });
        } }) }) }) };
      },
    } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client, queryTimeoutMs: 1_000 });
    await rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });

  test("a stalled database attempt aborts so the outbox can retry later", async () => {
    const client = {
      from() {
        return { insert: () => ({ select: () => ({ limit: () => ({ abortSignal: (signal: AbortSignal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ data: null, error: { message: "aborted" } }), { once: true });
        }) }) }) }) };
      },
    } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client, queryTimeoutMs: 20 });
    await expect(rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 })).rejects.toThrow(/aborted/);
  });

  test("reuses one session per (org, day, model) — N requests ⇒ 1 session insert, N billing rows", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    for (let i = 0; i < 3; i++) await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    expect(inserts.filter((i) => i.table === "sessions")).toHaveLength(1);
    expect(inserts.filter((i) => i.table === "billing_records")).toHaveLength(3);
    // all billing rows share the one session
    for (const b of inserts.filter((i) => i.table === "billing_records")) expect(b.row["session_id"]).toBe("sess-1");
  });

  test("CONCURRENT requests for the same (org, day, model) share ONE session insert (no TOCTOU race)", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    // recordUsage is fire-and-forget in the route, so overlapping calls can hit ensureSession before
    // the first insert resolves. The in-flight-promise cache must collapse them to ONE session.
    await Promise.all([
      rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 }),
      rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 2000, outputTokens: 20 }),
    ]);
    expect(inserts.filter((i) => i.table === "sessions")).toHaveLength(1); // not 2
    expect(inserts.filter((i) => i.table === "billing_records")).toHaveLength(2);
  });

  test("a different model gets its own session", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    await rec.recordUsage({ orgId: "org-1", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 10 });
    expect(inserts.filter((i) => i.table === "sessions")).toHaveLength(2);
  });

  test("same model/day uses separate distinct usage buckets by authenticated project", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    for (const projectScopeId of ["org-1/orion", "org-1/vega", "org-1/orion", undefined]) {
      await rec.recordUsage({ orgId: "org-1", ...(projectScopeId ? { projectScopeId } : {}), model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    }
    expect(inserts.filter((i) => i.table === "sessions").map((i) => i.row["project_scope"])).toEqual(["orion", "vega", null]);
    expect(inserts.filter((i) => i.table === "billing_records").map((i) => i.row["session_id"])).toEqual(["sess-1", "sess-2", "sess-1", "sess-3"]);
  });

  test("rejects an invalid or cross-organization project before any database write", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    for (const projectScopeId of ["org-2/orion", "org-1/../vega", "org-1/", "orion"]) {
      await expect(rec.recordUsage({ orgId: "org-1", projectScopeId, model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 })).rejects.toThrow(/project scope/);
    }
    expect(inserts).toHaveLength(0);
  });

  test("no-op when inputTokens <= 0 (billing_records CHECK original_tokens > 0)", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 });
    expect(inserts).toHaveLength(0);
  });

  test("cross-instance race: a 23505 on the sessions insert re-reads the winner bucket (no duplicate, no throw)", async () => {
    // Simulate another Vercel instance having already created today's usage bucket: the unique index
    // (sessions_usage_bucket_uniq) rejects our INSERT with 23505, and we converge on the existing row.
    let billingRow: Record<string, unknown> | undefined;
    const client = {
      from(table: string) {
        if (table === "sessions") {
          return {
            // INSERT path → unique-violation
            insert: () => ({ select: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }) }) }),
            // SELECT-or-re-read path → the winner's bucket id (chainable eq/gte/lt → limit)
            select: () => {
              const q = { eq: () => q, is: () => q, gte: () => q, lt: () => q, limit: () => Promise.resolve({ data: [{ id: "winner-bucket" }], error: null }) };
              return q;
            },
          };
        }
        return {
          insert(row: Record<string, unknown>) {
            billingRow = row;
            return { select: () => ({ limit: () => Promise.resolve({ data: [{ id: "rec-1" }], error: null }) }) };
          },
        };
      },
    } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    expect(billingRow?.["session_id"]).toBe("winner-bucket"); // recorded against the converged bucket, not a dup
  });

  test("cross-instance conflict re-read filters by the exact project", async () => {
    const filters: Array<[string, unknown]> = [];
    const client = {
      from(table: string) {
        if (table === "sessions") return {
          insert: () => ({ select: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate bucket" } }) }) }),
          select: () => {
            const q = {
              eq: (column: string, value: unknown) => { filters.push([column, value]); return q; },
              is: (column: string, value: unknown) => { filters.push([column, value]); return q; },
              gte: () => q,
              lt: () => q,
              limit: () => Promise.resolve({ data: [{ id: "winner" }], error: null }),
            };
            return q;
          },
        };
        return { insert: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [{ id: "record" }], error: null }) }) }) };
      },
    } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", projectScopeId: "org-1/orion", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    expect(filters).toContainEqual(["project_scope", "orion"]);
    await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    expect(filters).toContainEqual(["project_scope", null]);
  });

  test("refuses noncanonical occurrence times and invalid pinned prices before writing", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client });
    const event = { orgId: "org-1", model: "local/check", inputTokens: 10, outputTokens: 1 };
    for (const occurredAt of ["2026-05-30", "2026-05-30T12:00:00Z", "invalid"]) {
      await expect(rec.recordUsage({ ...event, occurredAt })).rejects.toThrow();
    }
    for (const apiPricePerToken of [0, -1, NaN, Infinity]) {
      await expect(rec.recordUsage({ ...event, apiPricePerToken })).rejects.toThrow(/pinned usage price/);
    }
    expect(inserts).toEqual([]);
  });

  test("evicts a failed session promise so a later delivery can persist", async () => {
    let attempts = 0;
    const client = { from(table: string) { return {
      insert: () => ({ select: () => ({ limit: () => Promise.resolve(table === "sessions" && ++attempts === 1
        ? { data: null, error: { message: "temporarily unavailable" } }
        : { data: [{ id: table === "sessions" ? "session" : "record" }], error: null }) }) }),
    }; } } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client, now: () => NOW });
    const event = { orgId: "org-1", model: "local/check", inputTokens: 10, outputTokens: 1 };
    await expect(rec.recordUsage(event)).rejects.toThrow(/temporarily unavailable/);
    await expect(rec.recordUsage(event)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test.each([null, "", " ", 1])("refuses an unconfirmed usage session ID %s", async (id) => {
    const client = { from() { return {
      insert: () => ({ select: () => ({ limit: () => Promise.resolve({ data: [{ id }], error: null }) }) }),
    }; } } as unknown as SupabaseClient;
    const rec = createSupabaseUsageRecorder({ client });
    await expect(rec.recordUsage({ orgId: "org-1", model: "local/check", inputTokens: 10, outputTokens: 1 })).rejects.toThrow(/no id/);
  });
});
