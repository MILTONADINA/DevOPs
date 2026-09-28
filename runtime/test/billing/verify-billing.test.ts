// Unit tests for verify-billing's pure seams (parseArgs, rowToInput). The verify
// LOGIC is covered in recorder.test.ts; the live read is exercised by `npm run verify-billing`.

import { describe, test, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signBillingRecord } from "../../src/billing/recorder";
import { main, parseArgs, rowToInput, verifyOrgBilling } from "../../scripts/verify-billing";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verification startup", () => {
  test("missing database credentials fail instead of reporting a successful skip", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "");
    vi.stubEnv("CQ_BILLING_SIGNING_SECRET", "");
    expect(await main(["--org-id", "00000000-0000-4000-8000-000000000001"])).toBe(1);
  });

  test("missing dedicated signing secret fails before database access", async () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "fixture-key");
    vi.stubEnv("CQ_BILLING_SIGNING_SECRET", "");
    expect(await main(["--org-id", "00000000-0000-4000-8000-000000000001"])).toBe(1);
  });
});

describe("parseArgs", () => {
  test("defaults + flags", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--org-id", "o1", "--since", "a", "--until", "b"])).toEqual({ orgId: "o1", since: "a", until: "b" });
  });
});

describe("rowToInput", () => {
  test("maps a stored row to its signing inputs; drops a null pruning_log_id", () => {
    const input = rowToInput({ id: "r1", session_id: "s1", org_id: "o1", original_tokens: 100, quarantined_tokens: 40, api_price_per_token: 0.000015, pruning_log_id: null, signed_hash: "h" });
    expect(input).toEqual({ sessionId: "s1", orgId: "o1", originalTokens: 100, quarantinedTokens: 40, apiPricePerToken: 0.000015 });
    expect(input).not.toHaveProperty("pruningLogId");
  });
  test("keeps a present pruning_log_id", () => {
    expect(rowToInput({ id: "r1", session_id: "s1", org_id: "o1", original_tokens: 1, quarantined_tokens: 0, api_price_per_token: 1, pruning_log_id: "pl1", signed_hash: "h" }).pruningLogId).toBe(
      "pl1",
    );
  });
  test("carries a usage event ID into the verifier's signing inputs", () => {
    const row = { id: "r1", session_id: "s1", org_id: "o1", original_tokens: 1, quarantined_tokens: 1, api_price_per_token: 1, pruning_log_id: null, usage_event_id: "00000000-0000-4000-8000-000000000123", signed_hash: "h" };
    expect(rowToInput(row).usageEventId).toBe(row.usage_event_id);
  });
});

describe("paged signature verification", () => {
  const orgId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const secret = "fixture-signing-secret";
  const rows = Array.from({ length: 1_001 }, (_, index) => ({
    id: `rec-${String(index).padStart(4, "0")}`,
    org_id: orgId,
    session_id: sessionId,
    original_tokens: 100,
    quarantined_tokens: 100,
    api_price_per_token: 0.00001,
    pruning_log_id: null,
    signed_hash: signBillingRecord({ orgId, sessionId, originalTokens: 100, quarantinedTokens: 100, apiPricePerToken: 0.00001 }, secret),
  }));

  function cappedClient(opts: { omitCount?: boolean; stallAt?: number; changeCountAt?: number } = {}): { client: SupabaseClient; ranges: number[] } {
    const ranges: number[] = [];
    const client = {
      from(table: string) {
        expect(table).toBe("billing_records");
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          gte() {
            return query;
          },
          lte() {
            return query;
          },
          order() {
            return query;
          },
          range(start: number, end: number) {
            ranges.push(start);
            return Promise.resolve({
              data: opts.stallAt !== undefined && start >= opts.stallAt ? [] : rows.slice(start, Math.min(end + 1, start + 500)),
              count: opts.omitCount ? null : opts.changeCountAt !== undefined && start >= opts.changeCountAt ? rows.length + 1 : rows.length,
              error: null,
            });
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    return { client, ranges };
  }

  test("finds tampering past the first REST page", async () => {
    const { client, ranges } = cappedClient();
    const last = rows[1_000]!;
    last.signed_hash = "0".repeat(64);
    const result = await verifyOrgBilling(client, orgId, secret);
    expect(result).toEqual({ records: 1_001, tampered: [last.id] });
    expect(ranges).toEqual([0, 500, 1_000]);
    last.signed_hash = signBillingRecord(rowToInput(last), secret);
  });

  test("missing exact count and stalled pages fail closed", async () => {
    await expect(verifyOrgBilling(cappedClient({ omitCount: true }).client, orgId, secret)).rejects.toThrow(/count/i);
    await expect(verifyOrgBilling(cappedClient({ stallAt: 500 }).client, orgId, secret)).rejects.toThrow(/page/i);
    await expect(verifyOrgBilling(cappedClient({ changeCountAt: 500 }).client, orgId, secret)).rejects.toThrow(/count changed/i);
  });
});
