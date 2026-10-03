// Reads behind the usage APIs stay off the ledger's fee and signature columns (specs/ops/payment-removal.md REQ-3, REQ-6). The client is a recording fake: it keeps every column string
// passed to select() and answers from in-memory tables whose billing_records rows DO carry cq_fee_usd and signed_hash, whatever the query selected, so a read that asked for those
// columns or passed the rows through would show in what it returns. The paged reads of the usage source keep the paging they had: blocks of 500 ordered by id under an exact count,
// with the org and the date bounds on every page.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSessionsDeps } from "../../src/proxy/routes/sessions";
import { createSupabaseUsageDeps, type UsageDeps } from "../../src/proxy/routes/usage";

type Row = Record<string, unknown>;

/** Any key that reads as a fee, an amount due, a minimum or a signature. */
const FEE_KEY = /fee|amount_?due|minimum|signed_hash/i;

/** Every object key in a JSON value, nested ones included. Keys only: an "estimate" note in a value must not be scanned. */
const keysDeep = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]) : []);

/**
 * How a read goes wrong. Every read fails with the database error `error`. A paged read: the source gives no exact count (`omitCount`), the count grows by one from the page that
 * starts at `changeCountAt` on, the count is `countAs` whatever the rows are, or every page that starts at `stallAt` or later comes back empty.
 */
interface Faults {
  coverage?: { data: unknown; error: { message: string } | null };
  error?: string;
  omitCount?: boolean;
  changeCountAt?: number;
  countAs?: number;
  stallAt?: number;
}

/** One range() read as the query carried it: its equality filters, its date bounds, its ordering and the row window it asked for. */
interface Page {
  filters: Array<[string, unknown]>;
  since: unknown;
  until: unknown;
  order: string;
  start: number;
  end: number;
}

/** The most rows one range() read returns, whatever window it asks for: a capped page, as the live API gives. */
const PAGE_CAP = 500;

/** The most range() reads one client answers. A paging loop that never ends then fails its case with an error, where it would otherwise spin on its own promises and hang the run. */
const MAX_RANGE_READS = 50;

/**
 * A Supabase client double over in-memory tables. Every column string passed to select() is recorded in `selects`; select() does not project the rows. A query keeps the rows that
 * match its eq()/is() filters. Without range() it is cut to limit(n) when one is set. With range(start, end) it is cut to that window, at most PAGE_CAP rows, and the read is recorded in
 * `pages`; gte(), lt() and order() are recorded there, not applied. It resolves { data, error, count } when it is awaited: `count` is the number of matching rows when a range() read's
 * select() asked for { count: "exact" }, and null when it did not. `faults` makes a read misbehave (see Faults). The MAX_RANGE_READS-plus-first range() read is refused.
 */
function recordingClient(tables: Record<string, Row[]>, faults: Faults = {}): { client: SupabaseClient; selects: string[]; pages: Page[]; operations: string[] } {
  const selects: string[] = [];
  const pages: Page[] = [];
  const operations: string[] = [];
  const client = {
    async rpc(name: string, args: { p_org_id?: string; p_reason?: string }) {
      expect(name).toBe("mark_erasure_coverage_unknown");
      expect(typeof args.p_org_id === "string" && args.p_org_id.length > 0).toBe(true);
      expect(args.p_reason).toBe("protected_read");
      operations.push("mark");
      return faults.coverage ?? { data: true, error: null };
    },
    from(table: string) {
      operations.push(`read:${table}`);
      const filters: Array<[string, unknown]> = [];
      let max = Number.POSITIVE_INFINITY;
      let since: unknown;
      let until: unknown;
      let order = "";
      let window: [number, number] | undefined;
      let exactCount = false;
      const query = {
        select(columns: string, options?: { count?: string }) {
          selects.push(columns);
          exactCount = options?.count === "exact";
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        is(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        gte(_column: string, value: unknown) {
          since = value;
          return query;
        },
        lt(_column: string, value: unknown) {
          until = value;
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          order = `${column} ${options?.ascending === false ? "desc" : "asc"}`;
          return query;
        },
        limit(n: number) {
          max = n;
          return query;
        },
        range(start: number, end: number) {
          window = [start, end];
          return query;
        },
        then(resolve: (result: { data: Row[] | null; error: { message: string } | null; count: number | null }) => unknown, reject?: (reason: unknown) => unknown) {
          if (faults.error !== undefined) return Promise.resolve({ data: null, error: { message: faults.error }, count: null }).then(resolve, reject);
          const matching = (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
          let data = matching.slice(0, max);
          let count: number | null = null;
          if (window !== undefined) {
            const [start, end] = window;
            if (pages.length >= MAX_RANGE_READS) return Promise.reject(new Error(`the read never ended: more than ${MAX_RANGE_READS} range reads`)).then(resolve, reject);
            pages.push({ filters: [...filters], since, until, order, start, end });
            data = faults.stallAt !== undefined && start >= faults.stallAt ? [] : matching.slice(start, Math.min(end + 1, start + PAGE_CAP));
            const grown = faults.changeCountAt !== undefined && start >= faults.changeCountAt;
            count = exactCount && faults.omitCount !== true ? (faults.countAs ?? matching.length + (grown ? 1 : 0)) : null;
          }
          return Promise.resolve({ data, error: null, count }).then(resolve, reject);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, selects, pages, operations };
}

/** An explicit session of org o1, the row the scope check in getSessionStats looks for. */
const SESSION: Row = {
  id: "s1",
  org_id: "o1",
  kind: "explicit",
  project_scope: null,
  created_at: "2026-05-30T00:00:00Z",
  ended_at: null,
  model: "claude-opus-4-8",
  lambda: 0.97,
  gain_shift: 0,
  theta: 1,
  zk_enabled: false,
  audit_enabled: true,
};

/** A usage row as the ledger stores it today: the fee and the signature ride along with the token counts. */
const usageRow = (overrides: Row = {}): Row => ({ org_id: "o1", session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h1", ...overrides });

/** Two rows for session s1 of org o1, plus one for another session and one for another org: the reads must leave those out. */
const USAGE_ROWS: Row[] = [usageRow(), usageRow({ signed_hash: "h2" }), usageRow({ session_id: "s2" }), usageRow({ org_id: "o2", original_tokens: 900_000 })];

describe("createSupabaseSessionsDeps.getSessionStats", () => {
  test("specs/ops/payment-removal.md#AC-3 and specs/ops/payment-removal.md#AC-6 session stats select no cq_fee_usd or signed_hash column and return no fee field", async () => {
    const { client, selects } = recordingClient({ sessions: [SESSION], billing_records: USAGE_ROWS });

    const stats = await createSupabaseSessionsDeps(client).getSessionStats("o1", "s1");

    // AC-3: no select names the fee or the signature column, and the estimated USD difference is still read.
    expect(selects.filter((columns) => /cq_fee_usd|signed_hash/.test(columns))).toEqual([]);
    expect(selects.some((columns) => columns.includes("cost_delta_usd"))).toBe(true);
    // AC-6: token totals and an estimated savings figure, and no key that reads as a fee, an amount due, a minimum or a signature.
    expect(stats).not.toBeNull();
    expect(keysDeep(stats).filter((key) => FEE_KEY.test(key))).toEqual([]);
    expect(stats).toEqual({ sessionId: "s1", billingRecords: 2, originalTokens: 100_000, quarantinedTokens: 15_000, savingsUsd: 1.28 });
  });
});

describe("usage read coverage (session-erasure AC-B3)", () => {
  const readers = ["summary", "developers", "records", "session stats"] as const;
  async function read(name: typeof readers[number], client: SupabaseClient): Promise<unknown> {
    const deps = createSupabaseUsageDeps(client);
    if (name === "summary") return deps.listUsageRecords("o1");
    if (name === "developers") return deps.developerBreakdown("o1");
    if (name === "records") return deps.listRecords("o1", { limit: 10, offset: 0 });
    return createSupabaseSessionsDeps(client).getSessionStats("o1", "s1");
  }
  test.each(readers)("%s commits uncertainty before the first protected usage query", async (name) => {
    const { client, operations } = recordingClient({ sessions: [SESSION], billing_records: USAGE_ROWS });
    await read(name, client);
    expect(operations.filter((op) => op !== "read:sessions")[0]).toBe("mark");
    expect(operations).toContain("read:billing_records");
    expect(operations.filter((op) => op === "mark")).toHaveLength(1);
  });
  test.each(readers)("%s refuses protected I/O after a failed or malformed acknowledgement", async (name) => {
    for (const coverage of [{ data: false, error: null }, { data: null, error: null }, { data: true, error: { message: "private DB text" } }]) {
      const { client, operations } = recordingClient({ sessions: [SESSION], billing_records: USAGE_ROWS }, { coverage });
      await expect(read(name, client)).rejects.toThrow("erasure coverage");
      expect(operations).not.toContain("read:billing_records");
      expect(operations).toContain("mark");
    }
  });
  test("metadata-only plan and foreign-session checks do not create content copies", async () => {
    const { client, operations } = recordingClient({ organizations: [{ id: "o1", plan: "growth" }], sessions: [SESSION] });
    expect(await createSupabaseUsageDeps(client).getOrgPlan("o1")).toBe("growth");
    expect(await createSupabaseSessionsDeps(client).getSessionStats("foreign", "s1")).toBeNull();
    expect(operations).toEqual(["read:organizations", "read:sessions"]);
  });
});

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const SINCE = "2026-01-01T00:00:00Z";
const UNTIL = "2026-02-01T00:00:00Z";

/** One ledger row of `org`: 100 original and 50 quarantined tokens, an estimated cost difference of 0, and every column the source has, the fee and the signature included. */
const pagedRow = (id: string, org: string): Row =>
  usageRow({ id, org_id: org, created_at: "2026-01-15T00:00:00Z", session_id: "session-1", original_tokens: 100, quarantined_tokens: 50, token_delta: 50, cost_delta_usd: 0, cq_fee_usd: 0.1, signed_hash: "fixture" });

const recId = (i: number): string => `rec-${String(i).padStart(4, "0")}`;

/** 1,001 rows for ORG (two capped pages of 500, and one row more) and 10 rows of another org, which a read scoped to ORG must leave out. */
const PAGED_ROWS: Row[] = [...Array.from({ length: 1_001 }, (_, i) => pagedRow(recId(i), ORG)), ...Array.from({ length: 10 }, (_, i) => pagedRow(`other-${i}`, OTHER_ORG))];

/** The pages a paged read of ORG's 1,001 rows over [SINCE, UNTIL) makes: blocks of 500 ordered by id, each under the same org and the same date bounds. */
const PAGED_READS: Page[] = [0, 500, 1_000].map((start) => ({ filters: [["org_id", ORG]], since: SINCE, until: UNTIL, order: "id asc", start, end: start + 499 }));

/** The seven fields a usage record has when listRecords returns it. */
const RECORD_FIELDS = ["cost_delta_usd", "created_at", "id", "original_tokens", "quarantined_tokens", "session_id", "token_delta"];

/** Both paged reads, so that a case can run its check against each. */
const PAGED_METHODS: Array<[string, (deps: UsageDeps) => Promise<unknown>]> = [
  ["listUsageRecords", (deps) => deps.listUsageRecords(ORG)],
  ["developerBreakdown", (deps) => deps.developerBreakdown(ORG)],
];

/** A usage source over the paged rows, with `faults` in the client. */
const pagedDeps = (faults: Faults): UsageDeps => createSupabaseUsageDeps(recordingClient({ billing_records: PAGED_ROWS }, faults).client);

/** The select() strings one read of a usage source made. Each read gets a fresh client, so that the selects of other reads do not mix in. */
const selectsOf = async (read: (deps: UsageDeps) => Promise<unknown>): Promise<string[]> => {
  const { client, selects } = recordingClient({ organizations: [{ id: ORG, plan: "growth" }], billing_records: PAGED_ROWS });
  await read(createSupabaseUsageDeps(client));
  return selects;
};

/** Rows with named developers: the embedded session is an object or a one-element array, its developer likewise, and one row has no session. The rows carry 60, 40, 30 and 50 tokens. */
const DEVELOPER_ROWS: Row[] = [
  usageRow({ org_id: ORG, original_tokens: 100, quarantined_tokens: 40, sessions: { developer_id: "d1", developers: [{ name: "Ada" }] } }),
  usageRow({ org_id: ORG, original_tokens: 100, quarantined_tokens: 60, sessions: [{ developer_id: "d2", developers: { name: "Grace" } }] }),
  usageRow({ org_id: ORG, original_tokens: 100, quarantined_tokens: 70, sessions: { developer_id: "d1", developers: { name: "Ada" } } }),
  usageRow({ org_id: ORG, original_tokens: 100, quarantined_tokens: 50, sessions: null }),
];

/** The per-developer entries of DEVELOPER_ROWS, in order of first appearance. */
const DEVELOPER_ENTRIES = [
  { developer_id: "d1", name: "Ada", token_delta: 90 },
  { developer_id: "d2", name: "Grace", token_delta: 40 },
  { developer_id: null, name: null, token_delta: 50 },
];

describe("createSupabaseUsageDeps paged reads", () => {
  // Mutation: dropping the org filter or a date bound from a page after the first, paging in blocks other than 500, or not ordering by id.
  test("specs/ops/payment-removal.md#AC-3 listUsageRecords reads all 1,001 rows over capped pages at 0, 500 and 1000, under the same org and date bounds on every page (regression guard)", async () => {
    const { client, pages } = recordingClient({ billing_records: PAGED_ROWS });
    const got = await createSupabaseUsageDeps(client).listUsageRecords(ORG, SINCE, UNTIL);
    expect(got).toHaveLength(1_001);
    expect(pages).toEqual(PAGED_READS);
  });

  test("specs/ops/payment-removal.md#AC-3 developerBreakdown counts every row, under the same org and date bounds on every page, and returns token_delta only", async () => {
    const { client, pages } = recordingClient({ billing_records: PAGED_ROWS });
    const got = await createSupabaseUsageDeps(client).developerBreakdown(ORG, SINCE, UNTIL);
    expect(got).toEqual([{ developer_id: null, name: null, token_delta: 50_050 }]);
    expect(pages).toEqual(PAGED_READS);
  });

  // Mutation: not checking the exact count, not comparing it from page to page, or trusting an empty page before the count is reached.
  test("specs/ops/payment-removal.md#AC-3 listUsageRecords and developerBreakdown reject a missing exact count, a changed count and a stalled page (regression guard)", async () => {
    for (const [name, read] of PAGED_METHODS) {
      await expect(read(pagedDeps({ omitCount: true })), name).rejects.toThrow(/count/i);
      await expect(read(pagedDeps({ changeCountAt: 500 })), name).rejects.toThrow(/count changed/i);
      await expect(read(pagedDeps({ stallAt: 500 })), name).rejects.toThrow(/page/i);
    }
  });

  // Mutation: dropping the exact-count check (a missing count would then trip a later check, under another message), its safe-integer or its non-negative part, or the check that the rows read stay within the count.
  test("specs/ops/payment-removal.md#AC-3 listUsageRecords and developerBreakdown report a missing count, and a count that is not a safe non-negative integer, as an unavailable exact count, and a page larger than the count as such (regression guard)", async () => {
    for (const [name, read] of PAGED_METHODS) {
      for (const faults of [{ omitCount: true }, { countAs: -1 }, { countAs: 1.5 }]) {
        await expect(read(pagedDeps(faults)), `${name} ${JSON.stringify(faults)}`).rejects.toThrow(/exact count unavailable/i);
      }
      await expect(read(pagedDeps({ countAs: 100 })), name).rejects.toThrow(/page exceeded exact row count/i);
    }
  });
});

describe("createSupabaseUsageDeps other reads", () => {
  // Mutation: dropping the error check of a read, so that a database error is answered as an empty result (a summary of zeros, an empty page) instead of failing.
  test("specs/ops/payment-removal.md#AC-3 every usage read fails with the database's error, and never answers a failed read with an empty result (regression guard)", async () => {
    const deps = createSupabaseUsageDeps(recordingClient({ organizations: [{ id: ORG, plan: "growth" }], billing_records: PAGED_ROWS }, { error: "boom" }).client);
    await expect(deps.getOrgPlan(ORG)).rejects.toThrow(/failed: boom/);
    await expect(deps.listUsageRecords(ORG)).rejects.toThrow(/failed: boom/);
    await expect(deps.developerBreakdown(ORG)).rejects.toThrow(/failed: boom/);
    await expect(deps.listRecords(ORG, { limit: 50, offset: 0 })).rejects.toThrow(/failed: boom/);
  });

  // Mutation: reading another column than plan, or not filtering by the organization id (an unknown org would get the first row's plan).
  test("specs/ops/payment-removal.md#AC-3 getOrgPlan reads the plan of the organization, and null for an unknown one (regression guard)", async () => {
    const { client, selects } = recordingClient({ organizations: [{ id: ORG, plan: "growth" }] });
    const deps = createSupabaseUsageDeps(client);
    expect(await deps.getOrgPlan(ORG)).toBe("growth");
    expect(await deps.getOrgPlan(OTHER_ORG)).toBeNull();
    expect(selects).toEqual(["plan", "plan"]);
  });

  // Mutation: dropping the since, until or session filter, the newest-first ordering or the offset and limit window, or taking the total from the page instead of the exact count.
  test("specs/ops/payment-removal.md#AC-3 listRecords reads one window of the organization's records, newest first, under the org, date and session filters, with the exact total (regression guard)", async () => {
    const { client, pages } = recordingClient({ billing_records: PAGED_ROWS });
    const got = await createSupabaseUsageDeps(client).listRecords(ORG, { since: SINCE, until: UNTIL, sessionId: "session-1", limit: 10, offset: 20 });
    expect(pages).toEqual([{ filters: [["org_id", ORG], ["session_id", "session-1"]], since: SINCE, until: UNTIL, order: "created_at desc", start: 20, end: 29 }]);
    expect(got.records.map((record) => record.id)).toEqual(Array.from({ length: 10 }, (_, i) => recId(20 + i)));
    expect(got.total).toBe(1_001);
  });

  test("specs/ops/payment-removal.md#AC-3 and specs/ops/payment-removal.md#AC-6 no select() names cq_fee_usd or signed_hash, and cost_delta_usd is still selected by listUsageRecords and listRecords", async () => {
    const plan = await selectsOf((deps) => deps.getOrgPlan(ORG));
    const usage = await selectsOf((deps) => deps.listUsageRecords(ORG));
    const developers = await selectsOf((deps) => deps.developerBreakdown(ORG));
    const records = await selectsOf((deps) => deps.listRecords(ORG, { limit: 50, offset: 0 }));

    // The reads ran: one select each, and one per page of 500 for the two paged reads.
    expect([plan.length, usage.length, developers.length, records.length]).toEqual([1, 3, 3, 1]);
    // AC-3: no select names the fee or the signature column, and none is a select-star that would fetch them.
    expect([...plan, ...usage, ...developers, ...records].filter((columns) => /cq_fee_usd|signed_hash|\*/.test(columns))).toEqual([]);
    // AC-6: the estimated USD difference is still read by the two reads that report it, and the per-developer read never selected it.
    expect(usage.every((columns) => columns.includes("cost_delta_usd"))).toBe(true);
    expect(records.every((columns) => columns.includes("cost_delta_usd"))).toBe(true);
    expect(developers.some((columns) => columns.includes("cost_delta_usd"))).toBe(false);
  });

  // The client double does not project rows, so only the select strings show a token column that a read dropped or a column it added.
  test("specs/ops/payment-removal.md#AC-3 each usage read selects exactly the columns it reports", async () => {
    expect(await selectsOf((deps) => deps.listUsageRecords(ORG))).toEqual(Array(3).fill("session_id, original_tokens, quarantined_tokens, cost_delta_usd"));
    expect(await selectsOf((deps) => deps.developerBreakdown(ORG))).toEqual(Array(3).fill("original_tokens, quarantined_tokens, sessions(developer_id, developers(name))"));
    expect(await selectsOf((deps) => deps.listRecords(ORG, { limit: 50, offset: 0 }))).toEqual(["id, created_at, session_id, original_tokens, quarantined_tokens, token_delta, cost_delta_usd"]);
  });

  test("specs/ops/payment-removal.md#AC-3 the rows listRecords returns and the developerBreakdown entries have no key that reads as a fee, an amount due, a minimum or a signature, though the source's rows carry those columns", async () => {
    // Precondition: the rows the source answers with really do carry the fee and the signature, so it is the reads that leave them out.
    expect(Object.keys(PAGED_ROWS[0] ?? {}).filter((key) => FEE_KEY.test(key))).toEqual(["cq_fee_usd", "signed_hash"]);

    const { records } = await createSupabaseUsageDeps(recordingClient({ billing_records: PAGED_ROWS }).client).listRecords(ORG, { limit: 3, offset: 0 });
    expect(records).toHaveLength(3);
    for (const record of records) expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
    expect(records[0]).toEqual({ id: recId(0), created_at: "2026-01-15T00:00:00Z", session_id: "session-1", original_tokens: 100, quarantined_tokens: 50, token_delta: 50, cost_delta_usd: 0 });
    expect(keysDeep(records).filter((key) => FEE_KEY.test(key))).toEqual([]);

    // Per developer, whichever way the source nests the session and the developer: each entry is a developer, a name and the summed token_delta, and nothing else.
    const entries = await createSupabaseUsageDeps(recordingClient({ billing_records: DEVELOPER_ROWS }).client).developerBreakdown(ORG);
    expect(entries).toEqual(DEVELOPER_ENTRIES);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["developer_id", "name", "token_delta"]);
    expect(keysDeep(entries).filter((key) => FEE_KEY.test(key))).toEqual([]);
  });
});
