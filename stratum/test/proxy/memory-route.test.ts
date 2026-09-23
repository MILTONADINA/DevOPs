// Tests for the memory API (facts / suppress / conflicts) via app.inject() with
// injected fake deps (no DB). Composes the Tier-2 warm adapter + audit_conflicts in prod.

import { describe, test, expect, vi } from "vitest";
import type { MemoryDeps, ConflictSummary, AuditStatusSummary } from "../../src/proxy/routes/memory";
import type { AnyFact } from "../../src/types/facts";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

const FACT = { id: "f1", fact_type: "Todo", description: "do x" } as unknown as AnyFact;
const CONFLICT: ConflictSummary = { id: "c1", detected_at: "t", fact_table: "function_changes", fact_id: "x", claimed_state: "a", actual_state: "b", conflict_commit: null, acknowledged: false };
const STATUS: AuditStatusSummary = { fact_table: "function_changes", fact_id: "f1", status: "CONFIRMED", audited_at: "t", evidence_commit: "abc", detail: null };

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
    listAuditStatuses: (orgId, limit) => {
      captured["statuses"] = { orgId, limit };
      return Promise.resolve([STATUS]);
    },
    listGraph: (orgId, limit) => {
      captured["graph"] = { orgId, limit };
      return Promise.resolve({ entities: [{ id: "n1", kind: "Function", name: "parseToken", session_id: null }], edges: [] });
    },
    searchGraph: (orgId, query, mode) => {
      captured["search"] = { orgId, query, mode };
      return Promise.resolve({ matches: ["n1"], entities: [{ id: "n1", kind: "Function", name: "parseToken", session_id: null, file_path: "src/token.ts", summary: "Parses a token" }], edges: [] });
    },
    listGraphFiles: (orgId, limit, after) => {
      captured["files"] = { orgId, limit, after };
      return Promise.resolve({ files: [{ id: "n2", kind: "File", name: "src/token.ts", session_id: null, file_path: "src/token.ts", summary: "Token source" }], next: null });
    },
    listGraphDependencies: (orgId, limit, after) => {
      captured["dependencies"] = { orgId, limit, after };
      return Promise.resolve({ edges: [{ id: "e1", edge_type: "DEPENDS_ON", from_entity: "n1", to_entity: "n2" }], next: null });
    },
    listRelatedFacts: (orgId, file) => {
      captured["related"] = { orgId, file };
      return Promise.resolve(file === "missing.ts" ? null : [{ id: "f1", kind: "FunctionChange", summary: "parseToken deprecated", created_at: "2026-09-23T00:00:00Z" }]);
    },
  };
  return { deps, captured };
}

describe("GET /v1/memory/graph", () => {
  test("uses authenticated org and caps the snapshot size", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/graph?org-id=other&limit=900", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().entities[0].name).toBe("parseToken");
    expect(captured["graph"]).toEqual({ orgId: "o9", limit: 500 });
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph?org-id=other" })).statusCode).toBe(401);
    await app.close();
  });

  test("requires an org in personal mode", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/memory/graph/search", () => {
  test("uses the authenticated organization and trims the query", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/graph/search?org-id=other&q=%20parseTokn%20", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toEqual(["n1"]);
    expect(captured["search"]).toEqual({ orgId: "o9", query: "parseTokn", mode: "name" });
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/search?org-id=other&q=token" })).statusCode).toBe(401);
    await app.close();
  });

  test("rejects missing, short, and oversized queries and needs org in personal mode", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    for (const q of ["", "a", "a".repeat(101)]) {
      const res = await app.inject({ method: "GET", url: `/v1/memory/graph/search?org-id=o1&q=${q}` });
      expect(res.statusCode).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/search?q=token" })).statusCode).toBe(400);
    await app.close();
  });

  test("selects semantic mode within the authenticated organization and rejects unknown modes", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const headers = { authorization: "Bearer k" };
    const result = await app.inject({ method: "GET", url: "/v1/memory/graph/search?org-id=foreign&q=token%20parser&mode=semantic", headers });
    expect(result.statusCode).toBe(200);
    expect(captured["search"]).toEqual({ orgId: "o9", query: "token parser", mode: "semantic" });
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/search?q=token&mode=other", headers })).statusCode).toBe(400);
    await app.close();
  });
});

describe("graph traversal pages", () => {
  test("binds files and dependencies to the key's organization and passes cursors", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const files = await app.inject({ method: "GET", url: "/v1/memory/graph/files?org-id=other&limit=2&after=src%2Fa.ts", headers: { authorization: "Bearer k" } });
    expect(files.statusCode).toBe(200);
    expect(files.json().files[0].name).toBe("src/token.ts");
    expect(captured["files"]).toEqual({ orgId: "o9", limit: 2, after: "src/a.ts" });
    const cursor = "11111111-1111-4111-8111-111111111111";
    const edges = await app.inject({ method: "GET", url: `/v1/memory/graph/dependencies?org-id=other&limit=3&after=${cursor}`, headers: { authorization: "Bearer k" } });
    expect(edges.statusCode).toBe(200);
    expect(captured["dependencies"]).toEqual({ orgId: "o9", limit: 3, after: cursor });
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/files?org-id=other" })).statusCode).toBe(401);
    await app.close();
  });

  test("rejects invalid limits and cursors and requires org in personal mode", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    for (const endpoint of ["files", "dependencies"]) {
      expect((await app.inject({ method: "GET", url: `/v1/memory/graph/${endpoint}` })).statusCode).toBe(400);
      for (const limit of ["0", "501", "abc"]) {
        expect((await app.inject({ method: "GET", url: `/v1/memory/graph/${endpoint}?org-id=o1&limit=${limit}` })).statusCode).toBe(400);
      }
    }
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/files?org-id=o1&after=" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/dependencies?org-id=o1&after=bogus" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/memory/graph/related-facts", () => {
  test("uses the API key's organization and an exact source path", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/graph/related-facts?file=src%2Ftoken.ts&org-id=other", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().facts[0].kind).toBe("FunctionChange");
    expect(captured["related"]).toEqual({ orgId: "o9", file: "src/token.ts" });
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/related-facts?file=src%2Ftoken.ts" })).statusCode).toBe(401);
    await app.close();
  });

  test("rejects invalid source paths and reports a missing indexed File", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, memory: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/related-facts?file=src%2Ftoken.ts" })).statusCode).toBe(400);
    for (const file of ["", "../secret.ts", "/tmp/a.ts", "src\\a.ts", "a".repeat(1025)]) {
      const res = await app.inject({ method: "GET", url: `/v1/memory/graph/related-facts?org-id=o1&file=${encodeURIComponent(file)}` });
      expect(res.statusCode).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/v1/memory/graph/related-facts?org-id=o1&file=missing.ts" })).statusCode).toBe(404);
    await app.close();
  });
});

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

describe("GET /v1/memory/audit-statuses", () => {
  test("lists persisted outcomes within the authenticated organization", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o9", keyId: "i" } : null) }, memory: deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/memory/audit-statuses?org-id=other&limit=3", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statuses: [STATUS] });
    expect(captured["statuses"]).toEqual({ orgId: "o9", limit: 3 });
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
