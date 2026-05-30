// Tests for the CFO billing API (/v1/billing/invoice + /audit.csv) via app.inject(),
// with injected fake billing deps (no DB). Composes the pure invoice engine.

import { describe, test, expect, vi } from "vitest";
import type { BillingDeps } from "../../src/proxy/routes/billing";
import type { BillableRecord } from "../../src/billing/invoice";
import type { ApiKeyResolver } from "../../src/proxy/auth";

// Real Fastify (the global setup mocks it).
vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

const RECORD: BillableRecord = { session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h1" };

function fakeDeps(): { deps: BillingDeps; captured: { orgId?: string; since?: string; until?: string } } {
  const captured: { orgId?: string; since?: string; until?: string } = {};
  const deps: BillingDeps = {
    getOrgPlan: (orgId) => Promise.resolve(orgId === "o1" ? "growth" : null),
    listBillingRecords: (orgId, since, until) => {
      captured.orgId = orgId;
      captured.since = since;
      captured.until = until;
      return Promise.resolve(orgId === "o1" ? [RECORD] : []);
    },
    listRecords: (orgId, q) => {
      captured.orgId = orgId;
      captured.since = q.since;
      captured.until = q.until;
      const full = { id: "r1", created_at: "t", session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, token_delta: 42_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h1" };
      return Promise.resolve(orgId === "o1" ? { records: [full], total: 1 } : { records: [], total: 0 });
    },
    developerBreakdown: (orgId) => Promise.resolve(orgId === "o1" ? [{ developer_id: null, name: null, token_delta: 42_500, cq_fee_usd: 0.13 }] : []),
    listInvoices: (orgId, q) => {
      captured.orgId = orgId;
      const all = [
        { id: "i1", created_at: "t2", stripe_invoice_id: "in_2", amount_cents: 9900, currency: "usd", status: "paid" as const, paid_at: "t3" },
        { id: "i2", created_at: "t1", stripe_invoice_id: "in_1", amount_cents: 5000, currency: "usd", status: "sent" as const, paid_at: null },
      ];
      const filtered = q.status ? all.filter((i) => i.status === q.status) : all;
      return Promise.resolve(orgId === "o1" ? { invoices: filtered, total: filtered.length } : { invoices: [], total: 0 });
    },
  };
  return { deps, captured };
}

describe("GET /v1/billing/invoice", () => {
  test("computes the invoice for ?org-id (growth plan → $99 minimum floor)", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoice?org-id=o1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ orgId: "o1", plan: "growth", recordCount: 1, effectivenessPct: 85, amountDueUsd: 99 });
    expect(body.lineItems).toHaveLength(1);
    await app.close();
  });

  test("400 when no org can be resolved (no auth, no ?org-id)", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoice" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  test("404 for an unknown org", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoice?org-id=ghost" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  test("passes since/until through to the record source", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    await app.inject({ method: "GET", url: "/v1/billing/invoice?org-id=o1&since=2026-05-01&until=2026-05-31" });
    expect(captured).toEqual({ orgId: "o1", since: "2026-05-01", until: "2026-05-31" });
    await app.close();
  });

  test("uses the AUTHENTICATED org (no ?org-id needed) when auth is on", async () => {
    const { deps, captured } = fakeDeps();
    const resolve: ApiKeyResolver = (raw) => Promise.resolve(raw === "good-key" ? { orgId: "o1", keyId: "k1" } : null);
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve }, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoice", headers: { authorization: "Bearer good-key" } });
    expect(res.statusCode).toBe(200);
    expect(captured.orgId).toBe("o1"); // scoped to the key's org, not a query param
    await app.close();
  });

  test("a malformed ?since is a 400 (not a 500 leaking a Postgres error)", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoice?org-id=o1&since=not-a-date" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/since must be an ISO-8601 timestamp/);
    await app.close();
  });
});

describe("GET /billing (CFO dashboard page)", () => {
  test("serves the vanilla HTML dashboard (no innerHTML, no org needed to load the shell)", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/billing" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("CFO Billing Dashboard");
    expect(res.body).toContain("/v1/billing/invoice?org-id=");
    expect(res.body).not.toContain(".innerHTML"); // XSS-safe by construction
    await app.close();
  });
});

describe("GET /v1/billing/audit.csv", () => {
  test("returns the signed-hash audit trail as a CSV download", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/audit.csv?org-id=o1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="audit-o1\.csv"/);
    const lines = res.body.split("\n");
    expect(lines[0]).toBe("session_id,original_tokens,quarantined_tokens,cost_delta_usd,cq_fee_usd,signed_hash");
    expect(lines[1]).toBe("s1,50000,7500,0.6375,0.1275,h1");
    await app.close();
  });
});

describe("GET /v1/billing/summary", () => {
  test("returns the monthly summary shape (token delta, fee, distinct sessions, effectiveness)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=o1&month=2026-05" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      org_id: "o1",
      period: "2026-05",
      total_original_tokens: 50_000,
      total_quarantined_tokens: 7_500,
      total_token_delta: 42_500,
      total_sessions: 1,
      average_pruning_effectiveness_pct: 85,
      by_developer: [{ developer_id: null, name: null, token_delta: 42_500, cq_fee_usd: 0.13 }],
    });
    await app.close();
  });
  test("400 on a malformed month; 404 for an unknown org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=o1&month=2026-13" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/billing/summary?org-id=ghost" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /v1/billing/records", () => {
  test("returns paginated full records with metadata; clamps limit to [1,500]", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, billing: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/records?org-id=o1&limit=9999&offset=0&since=2026-05-01" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.limit).toBe(500); // clamped from 9999
    expect(body.offset).toBe(0);
    expect(body.records[0]).toMatchObject({ id: "r1", session_id: "s1", token_delta: 42_500, signed_hash: "h1" });
    expect(captured.since).toBe("2026-05-01");
    await app.close();
  });
  test("400 with no org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/billing/records" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/billing/invoices", () => {
  test("lists the org's invoices (newest first), with total + pagination echo", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/billing/invoices?org-id=o1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 2, offset: 0, limit: 50 });
    expect(body.invoices.map((i: { stripe_invoice_id: string }) => i.stripe_invoice_id)).toEqual(["in_2", "in_1"]);
    expect(body.invoices[0]).toMatchObject({ status: "paid", amount_cents: 9900, paid_at: "t3" });
    await app.close();
  });

  test("?status=paid filters; an invalid status is 400", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    const paid = await app.inject({ method: "GET", url: "/v1/billing/invoices?org-id=o1&status=paid" });
    expect(paid.json().invoices).toHaveLength(1);
    expect(paid.json().invoices[0].status).toBe("paid");
    const bad = await app.inject({ method: "GET", url: "/v1/billing/invoices?org-id=o1&status=bogus" });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  test("404 for an unknown org, 400 with no org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, billing: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/billing/invoices?org-id=nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/billing/invoices" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("monthBounds", () => {
  test("converts YYYY-MM to [since, until); rolls over December; rejects bad input", async () => {
    const { monthBounds } = await import("../../src/proxy/routes/billing");
    expect(monthBounds("2026-05")).toEqual({ since: "2026-05-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" });
    expect(monthBounds("2026-12")).toEqual({ since: "2026-12-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" });
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("nope")).toBeNull();
  });
});
