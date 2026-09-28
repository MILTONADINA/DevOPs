import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBillingDeps } from "../../src/proxy/routes/billing";

const ORG = "00000000-0000-4000-8000-000000000001";
const SINCE = "2026-01-01T00:00:00Z";
const UNTIL = "2026-02-01T00:00:00Z";
const rows = Array.from({ length: 1_001 }, (_, i) => ({
  id: `rec-${String(i).padStart(4, "0")}`,
  session_id: "session-1",
  original_tokens: 100,
  quarantined_tokens: 50,
  cost_delta_usd: 0,
  cq_fee_usd: 0.1,
  signed_hash: "fixture",
}));

function cappedClient(opts: { omitCount?: boolean; changeCountAt?: number; stallAt?: number } = {}): {
  client: SupabaseClient;
  pages: Array<{ org: string; since: string; until: string; start: number; end: number }>;
} {
  const pages: Array<{ org: string; since: string; until: string; start: number; end: number }> = [];
  const client = {
    from(table: string) {
      expect(table).toBe("billing_records");
      let org = "";
      let since = "";
      let until = "";
      const query = {
        select() {
          return query;
        },
        eq(_column: string, value: string) {
          org = value;
          return query;
        },
        gte(_column: string, value: string) {
          since = value;
          return query;
        },
        lt(_column: string, value: string) {
          until = value;
          return query;
        },
        order() {
          return query;
        },
        range(start: number, end: number) {
          pages.push({ org, since, until, start, end });
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
  return { client, pages };
}

describe("complete billing source", () => {
  test("reads all capped pages under the same org and date bounds", async () => {
    const { client, pages } = cappedClient();
    const got = await createSupabaseBillingDeps(client).listBillingRecords(ORG, SINCE, UNTIL);
    expect(got).toHaveLength(1_001);
    expect(pages).toEqual([0, 500, 1_000].map((start) => ({ org: ORG, since: SINCE, until: UNTIL, start, end: start + 499 })));
  });

  test("developer breakdown includes every billed row", async () => {
    const { client, pages } = cappedClient();
    const got = await createSupabaseBillingDeps(client).developerBreakdown(ORG, SINCE, UNTIL);
    expect(got).toEqual([{ developer_id: null, name: null, token_delta: 50_050, cq_fee_usd: 100.1 }]);
    expect(pages.map((page) => page.start)).toEqual([0, 500, 1_000]);
  });

  test("rejects missing, changed, and incomplete exact counts", async () => {
    await expect(createSupabaseBillingDeps(cappedClient({ omitCount: true }).client).listBillingRecords(ORG)).rejects.toThrow(/count/i);
    await expect(createSupabaseBillingDeps(cappedClient({ changeCountAt: 500 }).client).listBillingRecords(ORG)).rejects.toThrow(/count changed/i);
    await expect(createSupabaseBillingDeps(cappedClient({ stallAt: 500 }).client).listBillingRecords(ORG)).rejects.toThrow(/page/i);
  });
});
