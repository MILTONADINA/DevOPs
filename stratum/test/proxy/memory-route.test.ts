// Tests for the memory API (facts / suppress / conflicts) via app.inject() with
// injected fake deps (no DB). Composes the Tier-2 warm adapter + audit_conflicts in prod.

import { describe, test, expect, vi } from "vitest";
import type { MemoryDeps, ConflictSummary } from "../../src/proxy/routes/memory";
import type { AnyFact } from "../../src/types/facts";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

const FACT = { id: "f1", fact_type: "Todo", description: "do x" } as unknown as AnyFact;
const CONFLICT: ConflictSummary = { id: "c1", detected_at: "t", fact_table: "function_changes", fact_id: "x", claimed_state: "a", actual_state: "b", conflict_commit: null, acknowledged: false };

function fakeDeps(): { deps: MemoryDeps; captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {};
  const deps: MemoryDeps = {
    listFacts: (orgId, limit) => {
      captured["facts"] = { orgId, limit };
      return Promise.resolve([FACT]);
    },
    suppressFact: (orgId, id, table) => {
      captured["suppress"] = { orgId, id, table };
      return Promise.resolve(id === "exists");
    },
    listConflicts: (orgId, limit) => {
      captured["conflicts"] = { orgId, limit };
      return Promise.resolve([CONFLICT]);
    },
  };
  return { deps, captured };
}

describe("GET /v1/memory/facts", () => {
  test("returns the org's facts and honors ?limit", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/facts?org-id=o1&limit=10" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ facts: [FACT] });
    expect(captured["facts"]).toEqual({ orgId: "o1", limit: 10 });
    await app.close();
  });

  test("400 with no org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/memory/facts" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /v1/memory/facts/:id", () => {
  test("suppresses an existing fact (valid table)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/v1/memory/facts/exists?org-id=o1&table=function_changes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "exists", table: "function_changes", suppressed: true });
    expect(captured["suppress"]).toEqual({ orgId: "o1", id: "exists", table: "function_changes" });
    await app.close();
  });

  test("400 when ?table is missing or not a known fact table", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "DELETE", url: "/v1/memory/facts/x?org-id=o1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/v1/memory/facts/x?org-id=o1&table=organizations" })).statusCode).toBe(400);
    await app.close();
  });

  test("404 when no row was suppressed", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/v1/memory/facts/ghost?org-id=o1&table=todos" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /v1/memory/conflicts", () => {
  test("returns the org's unacknowledged conflicts", async () => {
    const { deps } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/conflicts?org-id=o1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ conflicts: [CONFLICT] });
    await app.close();
  });

  test("scopes to the AUTHENTICATED org when auth is on", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/conflicts", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect((captured["conflicts"] as { orgId: string }).orgId).toBe("o9");
    await app.close();
  });
});
