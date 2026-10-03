// specs/memory/session-erasure.md AC-B3/B13: normal graph writers return only
// identity in the managed path; legacy content reads require durable marking.
import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createKnowledgeGraph } from "../../src/memory/cold/graph";
import { makeFakeSupabase } from "./fake-supabase";
import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";

const rowId = "40000000-0000-4000-8000-000000000001";
const inputs: Array<[string, (client: SupabaseClient) => Promise<string>, object]> = [
  ["write_managed_graph_entity", (c) => createKnowledgeGraph(c).ensureEntity({ orgId: "org", sessionId: "session", projectScope: null, kind: "File", name: "a.ts", filePath: "a.ts", summary: "summary" }),
    { kind: "File", name: "a.ts", project_scope: null, scope_verified: true, file_path: "a.ts", summary: "summary" }],
  ["write_managed_graph_edge", (c) => createKnowledgeGraph(c).addEdge({ orgId: "org", sessionId: "session", projectScope: "orion", fromEntity: "from", toEntity: "to", edgeType: "DEPENDS_ON" }),
    { from_entity: "from", to_entity: "to", edge_type: "DEPENDS_ON", project_scope: "orion", scope_verified: true }],
];

describe("managed graph writer boundary", () => {
  test.each(inputs)("%s returns ID without application content reads or marking", async (name, write, input) => {
    const rpc = vi.fn(async () => ({ data: rowId, error: null }));
    const from = vi.fn(() => { throw new Error("content must remain inside the transaction"); });
    const client = { rpc, from } as unknown as SupabaseClient;
    expect(await write(client)).toBe(rowId);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(name, { p_org_id: "org", p_session_id: "session", p_input: input });
    expect(from).not.toHaveBeenCalled();
  });
  test.each(inputs)("%s errors and malformed replies cannot fall back to a content read", async (name, write) => {
    for (const reply of [{ data: undefined, error: null }, { data: [], error: null }, { data: "bad-id", error: null }, { data: null, error: { message: "private SQL" } }]) {
      const rpc = vi.fn(async () => reply);
      const from = vi.fn(() => { throw new Error("protected read escaped guard"); });
      await expect(write({ rpc, from } as unknown as SupabaseClient)).rejects.toThrow("managed graph write");
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]).toBeDefined();
      expect(from).not.toHaveBeenCalled();
    }
  });
  test.each(inputs)("%s literal NULL requires successful marking before legacy reads", async (name, write) => {
    const calls: string[] = [];
    const from = vi.fn(() => { throw new Error("protected read escaped failed marking"); });
    const client = { from, rpc: async (rpc: string) => {
      calls.push(rpc);
      return { data: rpc === name ? null : false, error: null };
    } } as unknown as SupabaseClient;
    await expect(write(client)).rejects.toBeInstanceOf(ErasureCoverageUnavailableError);
    expect(calls).toEqual([name, "mark_erasure_coverage_unknown"]);
    expect(from).not.toHaveBeenCalled();
  });
  test.each(inputs)("%s sanitizes a rejected transport promise without fallback", async (_name, write) => {
    const rpc = vi.fn(async () => { throw new Error("private SQL evidence in transport failure"); });
    const from = vi.fn(() => { throw new Error("protected fallback"); });
    await expect(write({ rpc, from } as unknown as SupabaseClient)).rejects.toThrow(/^managed graph write unavailable$/);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });
  test("a pending marker after NULL cannot dispatch the legacy read", async () => {
    const legacy = makeFakeSupabase();
    let release!: (value: { data: boolean; error: null }) => void;
    let entered!: (value: boolean) => void;
    const pending = new Promise<{ data: boolean; error: null }>((resolve) => { release = resolve; });
    const marking = new Promise<boolean>((resolve) => { entered = resolve; });
    const from = vi.fn((table: string) => legacy.client.from(table));
    const client = { from, rpc: async (name: string) => {
      if (name === "write_managed_graph_entity") return { data: null, error: null };
      expect(name).toBe("mark_erasure_coverage_unknown");
      entered(true);
      return pending;
    } } as unknown as SupabaseClient;
    const result = createKnowledgeGraph(client).ensureEntity({ orgId: "org", kind: "File", name: "a.ts" });
    expect(await Promise.race([marking, result.then(() => false, () => false)])).toBe(true);
    expect(from).not.toHaveBeenCalled();
    release({ data: true, error: null });
    expect(await result).toBeTruthy();
    expect(from).toHaveBeenCalled();
  });
});

describe("graph recall copy boundaries", () => {
  const readers: Array<[string, (c: SupabaseClient) => Promise<unknown>]> = [
    ["superseded", (c) => createKnowledgeGraph(c).findSuperseded("org", ["old"])],
    ["project superseded", (c) => createKnowledgeGraph(c).findProjectSuperseded("org", "orion", ["old"])],
    ["entity status", (c) => createKnowledgeGraph(c).entityStatus("org", "old")],
  ];
  test.each(readers)("%s refuses all protected dispatch after denied marking", async (_name, read) => {
    const calls: string[] = [];
    const client = { rpc: async (name: string) => { calls.push(name); return { data: false, error: null }; },
      from: () => { calls.push("from"); throw new Error("unguarded content read"); } } as unknown as SupabaseClient;
    await expect(read(client)).rejects.toBeInstanceOf(ErasureCoverageUnavailableError);
    expect(calls).toEqual(["mark_erasure_coverage_unknown"]);
  });
});
