import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMemoryDeps, type MemoryDeps } from "../../src/proxy/routes/memory";
import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";

type Scope = string | null | undefined;
const operations: [string, (deps: MemoryDeps, scope: Scope) => Promise<unknown>][] = [
  ["conflicts", (deps, scope) => deps.listConflicts("o1", 10, scope)],
  ["statuses", (deps, scope) => deps.listAuditStatuses("o1", 10, scope)],
  ["graph", (deps, scope) => deps.listGraph("o1", 10, scope)],
  ["lexical search", (deps, scope) => deps.searchGraph("o1", "auth", "name", scope)],
  ["semantic search", (deps, scope) => deps.searchGraph("o1", "auth", "semantic", scope)],
  ["files", (deps, scope) => deps.listGraphFiles("o1", 10, "after.ts", scope)],
  ["dependencies", (deps, scope) => deps.listGraphDependencies("o1", 10, "after-id", scope)],
  ["related facts", (deps, scope) => deps.listRelatedFacts("o1", "src/a.ts", scope)],
];
const cases = operations.flatMap(([name, operation]) => [undefined, null, "orion"].map((scope) => [name, scope, operation] as const));

describe("specs/memory/session-erasure.md#AC-B3 — direct memory read boundaries", () => {
  test.each(cases)("%s scope=%s denies before every query or encoder dispatch", async (_name, scope, operation) => {
    const from = vi.fn(() => { throw new Error("protected table read"); });
    const rpc = vi.fn(async (name: string) => {
      if (name !== "mark_erasure_coverage_unknown") throw new Error("protected RPC read");
      return { data: false, error: null };
    });
    const encode = vi.fn(async () => [1]);
    await expect(operation(createSupabaseMemoryDeps({ from, rpc } as unknown as SupabaseClient, encode), scope)).rejects.toThrow(ErasureCoverageUnavailableError);
    expect(from).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: "o1", p_reason: "protected_read" });
  });

  test.each(operations)("%s awaits a pending marker before proceeding", async (_name, operation) => {
    let acknowledge!: (value: { data: boolean; error: null }) => void;
    const protectedRead = vi.fn(() => { throw new Error("protected-read-sentinel"); });
    const rpc = vi.fn((name: string) => name === "mark_erasure_coverage_unknown"
      ? new Promise<{ data: boolean; error: null }>((resolve) => { acknowledge = resolve; })
      : protectedRead());
    const encode = vi.fn(async () => [1]);
    const terminal = operation(createSupabaseMemoryDeps({ from: protectedRead, rpc } as unknown as SupabaseClient, encode), "orion").catch((error: unknown) => error);
    await Promise.resolve();
    expect(protectedRead).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    acknowledge({ data: true, error: null });
    expect((await terminal as Error).message).toContain("protected-read-sentinel");
    expect(protectedRead).toHaveBeenCalled();
  });

  test.each([undefined, null, "orion"])("acknowledged graph expansion preserves scoped neighbors/edges for scope=%s", async (scope) => {
    let acknowledged = false;
    const filters: [string, string, unknown][] = [];
    const matched = { id: "a", kind: "Function", name: "auth", session_id: "s1" };
    const neighbor = { id: "b", kind: "Function", name: "guard", session_id: "s2" };
    const edge = { id: "edge", edge_type: "REFERENCED_IN", from_entity: "a", to_entity: "b" };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "mark_erasure_coverage_unknown") { acknowledged = true; return { data: true, error: null }; }
      expect(acknowledged).toBe(true);
      expect(args["match_org"]).toBe("o1");
      if (scope !== undefined) expect(args["match_project_scope"]).toBe(scope);
      if (name.startsWith("search_")) return { data: [matched], error: null };
      expect(name).toBe(scope === undefined ? "list_graph_neighbor_entities" : "list_project_graph_neighbor_entities");
      expect(args["entity_ids"]).toEqual(["b"]);
      return { data: [neighbor], error: null };
    });
    const from = vi.fn((table: string) => {
      expect(acknowledged).toBe(true);
      expect(table).toBe("knowledge_edges");
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push(["eq", key, value]); return query; },
        is: (key: string, value: unknown) => { filters.push(["is", key, value]); return query; },
        in: () => query,
        limit: async () => ({ data: [edge], error: null }),
      };
      return query;
    });
    const deps = createSupabaseMemoryDeps({ rpc, from } as unknown as SupabaseClient);
    expect(await deps.searchGraph("o1", "auth", "name", scope)).toEqual({ matches: ["a"], entities: [matched, neighbor], edges: [edge] });
    expect(from).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.filter(([name]) => name === "mark_erasure_coverage_unknown")).toHaveLength(1);
    expect(filters.filter(([, key]) => key === "org_id")).toEqual([["eq", "org_id", "o1"], ["eq", "org_id", "o1"]]);
    if (scope !== undefined) {
      expect(filters.filter(([, key]) => key === "scope_verified")).toEqual([["eq", "scope_verified", true], ["eq", "scope_verified", true]]);
      expect(filters.filter(([, key]) => key === "project_scope")).toEqual([[scope === null ? "is" : "eq", "project_scope", scope], [scope === null ? "is" : "eq", "project_scope", scope]]);
    }
  });
});
