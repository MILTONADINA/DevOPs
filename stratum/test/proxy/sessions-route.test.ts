// Tests for the sessions API (list / metadata / stats) via app.inject() with fake deps.

import { describe, test, expect, vi } from "vitest";
import type { SessionsDeps, SessionSummary, SessionStats } from "../../src/proxy/routes/sessions";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

const SESSION: SessionSummary = { id: "s1", created_at: "t", ended_at: null, model: "claude-opus-4-8", lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true };
const STATS: SessionStats = { sessionId: "s1", billingRecords: 2, originalTokens: 100_000, quarantinedTokens: 15_000, savingsUsd: 1.28, feeUsd: 0.26 };

function fakeDeps(opts: { active?: number } = {}): { deps: SessionsDeps; captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {};
  const deps: SessionsDeps = {
    listSessions: (orgId, limit) => {
      captured["list"] = { orgId, limit };
      return Promise.resolve([SESSION]);
    },
    getSession: (_orgId, id) => Promise.resolve(id === "s1" ? SESSION : null),
    getSessionStats: (_orgId, id) => Promise.resolve(id === "s1" ? STATS : null),
    endSession: (_orgId, id) => {
      captured["ended"] = id;
      return Promise.resolve(id === "s1" ? { ...SESSION, ended_at: "2026-05-30T00:00:00Z" } : null);
    },
    getPlan: (orgId) => Promise.resolve(orgId === "o1" ? "starter" : null), // starter → concurrent cap 1
    countActiveSessions: () => Promise.resolve(opts.active ?? 0),
    createSession: (orgId, model) => {
      captured["created"] = { orgId, model };
      return Promise.resolve({ ...SESSION, id: "new-s", model });
    },
  };
  return { deps, captured };
}

describe("GET /v1/sessions", () => {
  test("lists the org's sessions; honors ?limit", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, sessions: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/sessions?org-id=o1&limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [SESSION] });
    expect(captured["list"]).toEqual({ orgId: "o1", limit: 5 });
    await app.close();
  });

  test("400 with no org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, sessions: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/sessions" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/sessions/:id", () => {
  test("returns a session in the org; 404 for an unknown id", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, sessions: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/sessions/s1?org-id=o1" })).json()).toEqual(SESSION);
    expect((await app.inject({ method: "GET", url: "/v1/sessions/ghost?org-id=o1" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /v1/sessions", () => {
  test("creates a session under the plan's concurrent cap (starter=1, 0 active → 201)", async () => {
    const { deps, captured } = fakeDeps({ active: 0 });
    const app = buildProxy({ rateLimit: false, cors: false, sessions: deps });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/sessions?org-id=o1", headers: { "content-type": "application/json" }, payload: { model: "claude-haiku-4-5" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "new-s", model: "claude-haiku-4-5" });
    expect(captured["created"]).toEqual({ orgId: "o1", model: "claude-haiku-4-5" });
    await app.close();
  });
  test("429 when the org is already at its concurrent-session cap (starter=1, 1 active)", async () => {
    const { deps, captured } = fakeDeps({ active: 1 });
    const app = buildProxy({ rateLimit: false, cors: false, sessions: deps });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/sessions?org-id=o1", headers: { "content-type": "application/json" }, payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { type: "rate_limit_error", limit_type: "concurrent_sessions" } });
    expect(captured["created"]).toBeUndefined(); // never created over the cap
    await app.close();
  });
  test("400 no org; 404 unknown org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, sessions: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "POST", url: "/v1/sessions", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/sessions?org-id=ghost", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE /v1/sessions/:id", () => {
  test("ends a session (sets ended_at); 404 for an unknown id", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, sessions: deps });
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/v1/sessions/s1?org-id=o1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ended: true, session: { id: "s1", ended_at: "2026-05-30T00:00:00Z" } });
    expect(captured["ended"]).toBe("s1");
    expect((await app.inject({ method: "DELETE", url: "/v1/sessions/ghost?org-id=o1" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /v1/sessions/:id/stats", () => {
  test("returns token totals + savings; 404 for an unknown id", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, sessions: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/sessions/s1/stats?org-id=o1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATS);
    expect((await app.inject({ method: "GET", url: "/v1/sessions/ghost/stats?org-id=o1" })).statusCode).toBe(404);
    await app.close();
  });

  test("scopes to the AUTHENTICATED org when auth is on", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o7", keyId: "i" } : null) }, sessions: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/sessions?limit=3", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(captured["list"]).toEqual({ orgId: "o7", limit: 3 });
    await app.close();
  });
});
