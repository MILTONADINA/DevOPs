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
