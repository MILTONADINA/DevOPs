// specs/memory/session-erasure.md AC-B3: every protected RPC waits for a
// durable uncertainty acknowledgement, including project-wide graph lookup.
import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createVectorStore } from "../../src/memory/cold/vectors";
import { createExchangeFunctionLookup, createFactExchangeCoverageLookup, createFreshFunctionSupersessionLookup, createProjectFunctionSupersessionLookup } from "../../src/memory/warm/exchange-function-entities";
import { createQueryFactCandidateLookup } from "../../src/memory/warm/query-fact-exchanges";
import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";

const embedding = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
const readers: Array<[string, (client: SupabaseClient) => Promise<unknown>]> = [
  ["match_memory_vectors", (c) => createVectorStore(c).search("org", embedding)],
  ["match_project_fact_vectors", (c) => createVectorStore(c).searchProjectFacts("org", "orion", embedding)],
  ["find_exchange_function_entities", (c) => createExchangeFunctionLookup(c)("org", "session", "orion", ["exchange"])],
  ["find_active_fact_exchanges", (c) => createFactExchangeCoverageLookup(c)("org", "session", "orion", ["exchange"])],
  ["find_fresh_exchange_function_superseded", (c) => createFreshFunctionSupersessionLookup(c)("org", "session", "orion", ["exchange"])],
  ["find_project_function_superseded", (c) => createProjectFunctionSupersessionLookup(c)("org", "orion", ["function"])],
  ["find_query_hot_fact_exchanges", (c) => createQueryFactCandidateLookup(c)("org", "session", "orion", ["exchange"], "query")],
];

describe("protected RPC copy coverage", () => {
  test.each(readers)("%s waits for successful marking before protected dispatch", async (name, read) => {
    const calls: string[] = [];
    const client = { rpc: async (rpc: string, args: unknown) => {
      calls.push(rpc);
      if (rpc === "mark_erasure_coverage_unknown") {
        expect(args).toEqual({ p_org_id: "org", p_reason: "protected_read" });
        return { data: true, error: null };
      }
      expect(rpc).toBe(name);
      return { data: [], error: null };
    } } as unknown as SupabaseClient;
    await read(client);
    expect(calls).toEqual(["mark_erasure_coverage_unknown", name]);
  });
  test.each(readers)("%s stops before any protected query on marking failure", async (_name, read) => {
    for (const response of [{ data: false, error: null }, { data: true, error: { message: "private SQL evidence" } }]) {
      const calls: string[] = [];
      const client = { rpc: async (rpc: string) => {
        calls.push(rpc);
        return rpc === "mark_erasure_coverage_unknown" ? response : { data: [], error: null };
      } } as unknown as SupabaseClient;
      await expect(read(client)).rejects.toBeInstanceOf(ErasureCoverageUnavailableError);
      expect(calls).toEqual(["mark_erasure_coverage_unknown"]);
    }
  });
  test("empty lookup inputs and invalid embedding dimensions dispatch nothing", async () => {
    const calls: string[] = [];
    const client = { rpc: async (rpc: string) => { calls.push(rpc); throw new Error("unexpected I/O"); } } as unknown as SupabaseClient;
    await createExchangeFunctionLookup(client)("org", "session", "orion", []);
    await createFactExchangeCoverageLookup(client)("org", "session", "orion", []);
    await createFreshFunctionSupersessionLookup(client)("org", "session", "orion", []);
    await createProjectFunctionSupersessionLookup(client)("org", "orion", []);
    await createQueryFactCandidateLookup(client)("org", "session", "orion", [], "query");
    await createQueryFactCandidateLookup(client)("org", "session", "orion", ["exchange"], " ");
    await expect(createVectorStore(client).search("org", [1])).rejects.toThrow("dimension");
    await expect(createVectorStore(client).searchProjectFacts("org", "orion", [1])).rejects.toThrow("dimension");
    expect(calls).toEqual([]);
  });
});
