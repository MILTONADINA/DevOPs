// Tests for the commercial usage recorder (request path → signed billing_record). Uses an injected
// FAKE Supabase client — billing_records is append-only (no delete), so this layer is NEVER live-written
// in tests (the recorder.ts discipline). Verifies session reuse, the honest 0-savings record, and signing.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseUsageRecorder } from "../../src/billing/usage-recorder";
import { verifyBillingRecord } from "../../src/billing/recorder";

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

const SECRET = "billing-secret";
const NOW = Date.UTC(2026, 4, 30, 12, 0, 0); // fixed → one UTC-day bucket

describe("createSupabaseUsageRecorder", () => {
  test("records a signed, honest 0-savings usage record (original == quarantined)", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, signingSecret: SECRET, now: () => NOW, priceFn: () => 0.000003 });
    await rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 500 });

    const session = inserts.find((i) => i.table === "sessions");
    const billing = inserts.find((i) => i.table === "billing_records");
    expect(session?.row).toEqual({ org_id: "org-1", model: "claude-sonnet-4-6" });
    expect(billing?.row).toMatchObject({ org_id: "org-1", session_id: "sess-1", original_tokens: 8000, quarantined_tokens: 8000, api_price_per_token: 0.000003 });

    // The signed_hash verifies against the immutable inputs (tamper-proof, like every billing row).
    const ok = verifyBillingRecord(
      { orgId: "org-1", sessionId: "sess-1", originalTokens: 8000, quarantinedTokens: 8000, apiPricePerToken: 0.000003 },
      billing?.row["signed_hash"] as string,
      SECRET,
    );
    expect(ok).toBe(true);
  });

  test("reuses one session per (org, day, model) — N requests ⇒ 1 session insert, N billing rows", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, signingSecret: SECRET, now: () => NOW });
    for (let i = 0; i < 3; i++) await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    expect(inserts.filter((i) => i.table === "sessions")).toHaveLength(1);
    expect(inserts.filter((i) => i.table === "billing_records")).toHaveLength(3);
    // all billing rows share the one session
    for (const b of inserts.filter((i) => i.table === "billing_records")) expect(b.row["session_id"]).toBe("sess-1");
  });

  test("CONCURRENT requests for the same (org, day, model) share ONE session insert (no TOCTOU race)", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, signingSecret: SECRET, now: () => NOW });
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
    const rec = createSupabaseUsageRecorder({ client, signingSecret: SECRET, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 10 });
    await rec.recordUsage({ orgId: "org-1", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 10 });
    expect(inserts.filter((i) => i.table === "sessions")).toHaveLength(2);
  });

  test("no-op when inputTokens <= 0 (billing_records CHECK original_tokens > 0)", async () => {
    const { client, inserts } = fakeClient();
    const rec = createSupabaseUsageRecorder({ client, signingSecret: SECRET, now: () => NOW });
    await rec.recordUsage({ orgId: "org-1", model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 });
    expect(inserts).toHaveLength(0);
  });
});
