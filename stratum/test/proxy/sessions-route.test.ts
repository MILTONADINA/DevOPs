// Tests for the sessions API (list / metadata / stats) via app.inject() with fake deps.

import { describe, test, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSessionsDeps, type SessionsDeps, type SessionSummary, type SessionStats } from "../../src/proxy/routes/sessions";

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
    // The atomic cap path the POST route now uses: returns null at/over the cap, else the new session.
    createSessionIfUnderCap: (orgId, model, limit) => {
      if ((opts.active ?? 0) >= limit) return Promise.resolve(null);
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

  test("caps ?limit at 500 (no unbounded query)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, sessions: deps });
    await app.ready();
    await app.inject({ method: "GET", url: "/v1/sessions?org-id=o1&limit=9999999" });
    expect((captured["list"] as { limit: number }).limit).toBe(500);
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

describe("createSupabaseSessionsDeps.countActiveSessions — only active EXPLICIT sessions (PB-46)", () => {
  test("filters org_id + kind='explicit' + ended_at IS NULL (usage buckets excluded from the cap)", async () => {
    const eqs: [string, unknown][] = [];
    const isNull: string[] = [];
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      is(col: string, _val: unknown) {
        isNull.push(col);
        return Promise.resolve({ count: 3, error: null });
      },
    };
    const client = { from: () => builder } as unknown as SupabaseClient;
    const n = await createSupabaseSessionsDeps(client).countActiveSessions("o1");
    expect(n).toBe(3);
    expect(eqs).toContainEqual(["org_id", "o1"]);
    expect(eqs).toContainEqual(["kind", "explicit"]); // PB-46: usage buckets must NOT count toward the cap
    expect(isNull).toContain("ended_at");
  });
});

describe("createSupabaseSessionsDeps.listSessions — only EXPLICIT sessions (audit: usage buckets hidden)", () => {
  test("filters org_id + kind='explicit' so internal usage buckets never appear in the list", async () => {
    const eqs: [string, unknown][] = [];
    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return Promise.resolve({ data: [], error: null });
      },
    };
    const client = { from: () => builder } as unknown as SupabaseClient;
    await createSupabaseSessionsDeps(client).listSessions("o1", 50);
    expect(eqs).toContainEqual(["org_id", "o1"]);
    expect(eqs).toContainEqual(["kind", "explicit"]);
  });
});

describe("createSupabaseSessionsDeps.createSessionIfUnderCap — atomic advisory-locked cap (audit: TOCTOU fix)", () => {
  test("calls the create_session_if_under_cap RPC with (org, model, cap) and maps the returned row", async () => {
    let rpcArgs: unknown;
    const client = {
      rpc(_fn: string, args: unknown) {
        rpcArgs = args;
        return Promise.resolve({ data: [{ id: "new-s", created_at: "t", ended_at: null, model: "m", lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true, org_id: "o1", kind: "explicit" }], error: null });
      },
    } as unknown as SupabaseClient;
    const row = await createSupabaseSessionsDeps(client).createSessionIfUnderCap("o1", "m", 1);
    expect(rpcArgs).toEqual({ p_org_id: "o1", p_model: "m", p_cap: 1 });
    // Response is mapped to the SessionSummary shape (no org_id/kind leakage into the API response).
    expect(row).toEqual({ id: "new-s", created_at: "t", ended_at: null, model: "m", lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true });
  });

  test("returns null when the RPC yields no row (org already at/over the cap)", async () => {
    const client = { rpc: () => Promise.resolve({ data: [], error: null }) } as unknown as SupabaseClient;
    const row = await createSupabaseSessionsDeps(client).createSessionIfUnderCap("o1", "m", 1);
    expect(row).toBeNull();
  });
});
