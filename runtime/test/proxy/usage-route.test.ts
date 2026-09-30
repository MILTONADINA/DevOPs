// Tests for the usage read API (GET /v1/billing/summary and GET /v1/billing/records; specs/ops/payment-removal.md REQ-3 and REQ-6) through app.inject(), over fake usage deps (no database).
// The API serves token totals and an estimated USD cost difference, and nothing that reads as a fee, a plan minimum or an amount due. The route cases moved here from the billing route test
// keep every non-fee assertion; each assertion there on a fee or a signature is turned into an absence assertion, because REQ-3 forbids those fields (owner decision of 2026-09-26).

import { describe, test, expect, vi } from "vitest";
import { monthBounds, type UsageDeps } from "../../src/proxy/routes/usage";
import type { UsageRecord } from "../../src/usage/summary";
import type { ApiKeyResolver } from "../../src/proxy/auth";

// Real Fastify (the global setup mocks it).
vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

/** Any key that reads as a fee, an amount due, a minimum or a signature. */
const FEE_KEY = /fee|amount_?due|minimum|signed_hash/i;

/** Every object key in a JSON value, nested ones included. Keys only: an "estimate" note in a value must not be scanned. */
const keysDeep = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]) : []);

/** One usage record: 50,000 original and 7,500 quarantined tokens, an estimated cost difference of 0.6375. */
const RECORD: UsageRecord = { session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375 };

/** The same record as the records endpoint returns it. */
const FULL_RECORD = { id: "r1", created_at: "t", session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, token_delta: 42_500, cost_delta_usd: 0.6375 };

type Captured = { orgId?: string | undefined; since?: string | undefined; until?: string | undefined };

/** A fake usage source. Org o1 is on the growth plan and has RECORD; any other org is unknown and has nothing. `captured` keeps the org and the window of the latest record read. */
function fakeDeps(): { deps: UsageDeps; captured: Captured } {
  const captured: Captured = {};
  const deps: UsageDeps = {
    getOrgPlan: (orgId) => Promise.resolve(orgId === "o1" ? "growth" : null),
    listUsageRecords: (orgId, since, until) => {
      captured.orgId = orgId;
      captured.since = since;
      captured.until = until;
      return Promise.resolve(orgId === "o1" ? [RECORD] : []);
    },
    listRecords: (orgId, q) => {
      captured.orgId = orgId;
      captured.since = q.since;
      captured.until = q.until;
      return Promise.resolve(orgId === "o1" ? { records: [FULL_RECORD], total: 1 } : { records: [], total: 0 });
    },
    developerBreakdown: (orgId) => Promise.resolve(orgId === "o1" ? [{ developer_id: null, name: null, token_delta: 42_500 }] : []),
  };
  return { deps, captured };
}

/** Key resolver: "bound" is a project-bound key of org o1, "unbound" an organization-level key of o1, "good-key" a plain key of o1. */
const resolve: ApiKeyResolver = (raw) =>
  Promise.resolve(
    raw === "bound" ? { orgId: "o1", keyId: "bound-id", projectScopeId: "o1/orion" } : raw === "unbound" ? { orgId: "o1", keyId: "org-id" } : raw === "good-key" ? { orgId: "o1", keyId: "k1" } : null,
  );

const PATHS = ["summary", "records"];

describe("GET /v1/billing/summary", () => {
  // Mutation: the route adding a fee or amount-due key to the summary, dropping a total from it, or reading the totals from the wrong records.
  test("specs/ops/payment-removal.md#AC-3 returns the usage summary shape (token delta, distinct sessions, effectiveness, per-developer breakdown) and no fee field", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, usage: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=o1&month=2026-05" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      org_id: "o1",
      period: "2026-05",
      total_original_tokens: 50_000,
      total_quarantined_tokens: 7_500,
      total_token_delta: 42_500,
      total_sessions: 1,
      average_pruning_effectiveness_pct: 85,
      by_developer: [{ developer_id: null, name: null, token_delta: 42_500 }],
    });
    // REQ-3: no fee anywhere in the response, at the top level or per developer. The key list is exact, so no other key can slip in either.
    expect(body).not.toHaveProperty("total_cq_fee_usd");
    expect(body.by_developer[0]).not.toHaveProperty("cq_fee_usd");
    expect(Object.keys(body).sort()).toEqual(
      [
        "org_id",
        "period",
        "total_original_tokens",
        "total_quarantined_tokens",
        "total_token_delta",
        "total_cost_delta_usd",
        "total_sessions",
        "average_pruning_effectiveness_pct",
        "by_developer",
      ].sort(),
    );
    await app.close();
  });

  // Mutation: validating ?month after the record read (a bad month would answer 200), or dropping the plan lookup (an unknown org would answer 200).
  test("specs/ops/payment-removal.md#AC-3 400 on a malformed month; 404 for an unknown org (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, usage: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=o1&month=2026-13" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=ghost" })).statusCode).toBe(404);
    await app.close();
  });

  // Mutation: reading the per-developer breakdown over a different window than the totals (for instance all time), or ignoring ?month, ?since or ?until.
  test("specs/ops/payment-removal.md#AC-3 the summary reads the totals and the per-developer breakdown over the same window: the ?month bounds, or ?since and ?until, or all time (regression guard)", async () => {
    const { deps } = fakeDeps();
    const totals = vi.spyOn(deps, "listUsageRecords");
    const developers = vi.spyOn(deps, "developerBreakdown");
    const app = buildProxy({ rateLimit: false, cors: false, usage: deps });
    await app.ready();
    const windows: Array<[string, string, string | undefined, string | undefined]> = [
      ["&month=2026-05", "2026-05", "2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
      ["&since=2026-05-01&until=2026-05-31", "2026-05-01", "2026-05-01", "2026-05-31"],
      ["", "(all time)", undefined, undefined],
    ];
    for (const [query, period, since, until] of windows) {
      const res = await app.inject({ method: "GET", url: `/v1/billing/summary?org-id=o1${query}` });
      expect(res.statusCode, query).toBe(200);
      expect(res.json().period, query).toBe(period);
      expect(totals, query).toHaveBeenLastCalledWith("o1", since, until);
      expect(developers, query).toHaveBeenLastCalledWith("o1", since, until);
    }
    await app.close();
  });
});

describe("GET /v1/billing/records", () => {
  // Mutation: the route adding a key of its own (a fee total, say) to the response, dropping offset or limit, or letting the limit clamp rise above 500.
  test("specs/ops/payment-removal.md#AC-3 returns paginated usage records with metadata and no signed_hash or fee field; clamps limit to [1,500] (regression guard)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, usage: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/records?org-id=o1&limit=9999&offset=0&since=2026-05-01" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.limit).toBe(500); // clamped from 9999
    expect(body.offset).toBe(0);
    expect(body.records[0]).toMatchObject({ id: "r1", session_id: "s1", token_delta: 42_500 });
    // REQ-3: no signature and no fee on a record, and the response carries nothing but the records and their page metadata.
    expect(body.records[0]).not.toHaveProperty("signed_hash");
    expect(body.records[0]).not.toHaveProperty("cq_fee_usd");
    expect(Object.keys(body).sort()).toEqual(["limit", "offset", "records", "total"]);
    expect(captured.since).toBe("2026-05-01");
    await app.close();
  });

  // Mutation: a default limit other than 50, a limit clamp that lets 0 through, a negative offset reaching the source, or the since, until or session_id filter dropped.
  test("specs/ops/payment-removal.md#AC-3 records: limit defaults to 50 and is clamped to [1,500], offset is at least 0, and since, until and session_id reach the source (regression guard)", async () => {
    const { deps } = fakeDeps();
    const listRecords = vi.spyOn(deps, "listRecords");
    const app = buildProxy({ rateLimit: false, cors: false, usage: deps });
    await app.ready();
    const get = async (query: string) => (await app.inject({ method: "GET", url: `/v1/billing/records?org-id=o1${query}` })).json();
    expect(await get("")).toMatchObject({ limit: 50, offset: 0 });
    expect(await get("&limit=0&offset=-5")).toMatchObject({ limit: 1, offset: 0 });
    expect(await get("&limit=25&offset=100&session_id=s1&since=2026-05-01&until=2026-05-31")).toMatchObject({ limit: 25, offset: 100 });
    expect(listRecords).toHaveBeenNthCalledWith(1, "o1", { since: undefined, until: undefined, sessionId: undefined, limit: 50, offset: 0 });
    expect(listRecords).toHaveBeenNthCalledWith(2, "o1", { since: undefined, until: undefined, sessionId: undefined, limit: 1, offset: 0 });
    expect(listRecords).toHaveBeenNthCalledWith(3, "o1", { since: "2026-05-01", until: "2026-05-31", sessionId: "s1", limit: 25, offset: 100 });
    await app.close();
  });
});

describe("both usage paths", () => {
  // Mutation: dropping isoParam for either bound on either route, so the raw value reaches the source (a Postgres syntax error, a 500 that leaks it).
  test("specs/ops/payment-removal.md#AC-3 a malformed ?since or ?until is a 400 on both paths, not a 500 leaking a Postgres error (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, usage: fakeDeps().deps });
    await app.ready();
    for (const path of PATHS) {
      for (const name of ["since", "until"]) {
        const res = await app.inject({ method: "GET", url: `/v1/billing/${path}?org-id=o1&${name}=not-a-date` });
        expect(res.statusCode, `${path} ${name}`).toBe(400);
        expect(res.json().error.message, `${path} ${name}`).toMatch(new RegExp(`${name} must be an ISO-8601 timestamp`));
      }
    }
    await app.close();
  });

  // Mutation: reading ?org-id ahead of the authenticated org in either route, so a client-supplied org (o2 here) reaches the source.
  test("specs/ops/payment-removal.md#AC-3 both paths scope to the AUTHENTICATED org when auth is on; a supplied ?org-id for another org is ignored (regression guard)", async () => {
    const { deps } = fakeDeps();
    const reads = { getOrgPlan: vi.spyOn(deps, "getOrgPlan"), listUsageRecords: vi.spyOn(deps, "listUsageRecords"), developerBreakdown: vi.spyOn(deps, "developerBreakdown"), listRecords: vi.spyOn(deps, "listRecords") };
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, usage: deps });
    await app.ready();
    for (const path of PATHS) {
      const res = await app.inject({ method: "GET", url: `/v1/billing/${path}?org-id=o2`, headers: { authorization: "Bearer good-key" } });
      expect(res.statusCode, path).toBe(200);
    }
    // Every read of each source, on both paths, was for the key's org.
    expect(Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.mock.calls.map((call) => call[0])]))).toEqual({
      getOrgPlan: ["o1"],
      listUsageRecords: ["o1"],
      developerBreakdown: ["o1"],
      listRecords: ["o1"],
    });
    await app.close();
  });

  // Mutation: dropping the "no org" 400 from either route (the summary would read the plan of an undefined org and answer 404, the records would answer 200 with an empty page).
  test("specs/ops/payment-removal.md#AC-3 400 when no org can be resolved (no auth, no ?org-id), on both paths (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, usage: fakeDeps().deps });
    await app.ready();
    for (const path of PATHS) {
      expect((await app.inject({ method: "GET", url: `/v1/billing/${path}` })).statusCode, path).toBe(400);
    }
    await app.close();
  });
});

describe("organization access to the usage read API for project-bound keys", () => {
  // Mutation: dropping the organization-level check from either route, or moving it after the first source read.
  test("specs/ops/payment-removal.md#AC-3 project-bound keys receive 403 before any usage source read, despite spoofed scope (regression guard)", async () => {
    const { deps } = fakeDeps();
    const reads = [vi.spyOn(deps, "getOrgPlan"), vi.spyOn(deps, "listUsageRecords"), vi.spyOn(deps, "listRecords"), vi.spyOn(deps, "developerBreakdown")];
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, usage: deps });
    await app.ready();
    for (const path of PATHS) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/billing/${path}?org-id=o1&project-scope=`,
        headers: { authorization: "Bearer bound", "x-project-scope": "" },
      });
      expect(response.statusCode, path).toBe(403);
      expect(response.json().error.message).toBe("organization-level key required");
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    await app.close();
  });

  // Mutation: refusing every authenticated key on the usage paths (the organization-level check inverted, or applied to unbound keys too).
  test("specs/ops/payment-removal.md#AC-3 an unbound organization key still reads both usage paths (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, usage: fakeDeps().deps });
    await app.ready();
    for (const path of PATHS) {
      const response = await app.inject({ method: "GET", url: `/v1/billing/${path}`, headers: { authorization: "Bearer unbound" } });
      expect(response.statusCode, path).toBe(200);
    }
    await app.close();
  });
});

describe("the usage read API carries no fee, plan minimum or amount due, and keeps the USD estimate", () => {
  test("specs/ops/payment-removal.md#AC-3 an organization key's summary has token totals and no key that reads as a fee, an amount due, a minimum or a signature", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, usage: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/summary?month=2026-05", headers: { authorization: "Bearer unbound" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total_original_tokens: 50_000, total_quarantined_tokens: 7_500, total_token_delta: 42_500, average_pruning_effectiveness_pct: 85 });
    // The scan reaches by_developer: the top-level and the nested token keys are among the keys it walked.
    expect(keysDeep(body)).toEqual(expect.arrayContaining(["total_token_delta", "by_developer", "developer_id", "token_delta"]));
    expect(keysDeep(body).filter((key) => FEE_KEY.test(key))).toEqual([]);
    await app.close();
  });

  // Mutation: the route adding a fee-shaped key of its own (a fee total, say) to the records response.
  test("specs/ops/payment-removal.md#AC-3 an organization key's records have token counts and no key that reads as a fee, an amount due, a minimum or a signature (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, usage: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/records", headers: { authorization: "Bearer unbound" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records[0]).toMatchObject({ original_tokens: 50_000, quarantined_tokens: 7_500, token_delta: 42_500 });
    expect(keysDeep(body)).toEqual(expect.arrayContaining(["records", "total", "original_tokens", "token_delta"]));
    expect(keysDeep(body).filter((key) => FEE_KEY.test(key))).toEqual([]);
    await app.close();
  });

  // Mutation: dropping the estimated cost difference from the summary or from a record.
  test("specs/ops/payment-removal.md#AC-6 the summary carries a numeric total_cost_delta_usd and the records carry a numeric cost_delta_usd (regression guard)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, usage: fakeDeps().deps });
    await app.ready();
    const summary = (await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=o1" })).json();
    expect(typeof summary.total_cost_delta_usd).toBe("number");
    expect(summary.total_cost_delta_usd).toBe(0.64); // 0.6375 rounded to cents
    const records = (await app.inject({ method: "GET", url: "/v1/billing/records?org-id=o1" })).json();
    expect(typeof records.records[0].cost_delta_usd).toBe("number");
    expect(records.records[0].cost_delta_usd).toBe(0.6375);
    await app.close();
  });
});

describe("monthBounds", () => {
  // Mutation: the December rollover keeping the same year, accepting month 13 or month 00, or a month pattern that is not anchored (so that a string merely containing YYYY-MM passes).
  test("specs/ops/payment-removal.md#AC-3 monthBounds converts YYYY-MM to [since, until); rolls over December; rejects bad input (regression guard)", () => {
    expect(monthBounds("2026-05")).toEqual({ since: "2026-05-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" });
    expect(monthBounds("2026-12")).toEqual({ since: "2026-12-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" });
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("2026-00")).toBeNull();
    expect(monthBounds("nope")).toBeNull();
    // Only a whole YYYY-MM string is a month.
    expect(monthBounds("x2026-05")).toBeNull();
    expect(monthBounds("2026-055")).toBeNull();
  });
});
