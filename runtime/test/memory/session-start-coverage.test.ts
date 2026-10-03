import { describe, expect, test, vi } from "vitest";
import { retrieveSessionContext, type SessionContextOptions } from "../../scripts/session-start-context";
import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";
import { makeFakeSupabase } from "./fake-supabase";

const ORG = "11111111-1111-1111-1111-111111111111";
const opts: SessionContextOptions = {
  projectRoot: "/project", boundRoot: "/project", orgId: ORG, projectScope: "orion",
  supabaseUrl: "http://127.0.0.1:54321", serviceKey: "unit-test-only", allowlistText: "127.0.0.1", task: "recall auth",
};
const row = { id: "fact-1", org_id: ORG, project_scope: "orion", is_suppressed: false, created_at: "2026-09-23T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: true, promoted_to_t3: false, decision_text: "retained-private-fact", domain: "auth" };
const embedding = [1, ...new Array(383).fill(0)];

describe("specs/memory/session-erasure.md#AC-B3 — SessionStart coverage denial", () => {
  test("vector coverage denial cannot enter lexical fallback or return retained facts", async () => {
    const lexical = vi.fn(() => []);
    const { client } = makeFakeSupabase({ tech_decisions: [row] }, {}, {
      match_project_fact_vectors: () => { throw new ErasureCoverageUnavailableError(); },
      search_project_warm_facts: lexical,
    });
    const encodeMany = vi.fn(async () => [embedding]);
    await expect(retrieveSessionContext(opts, { makeClient: () => client, encode: async () => embedding, encodeMany })).rejects.toThrow(ErasureCoverageUnavailableError);
    expect(lexical).not.toHaveBeenCalled();
    expect(encodeMany).not.toHaveBeenCalled();
  });

  test("fact hydration denial cannot fall back to retained warm candidates", async () => {
    let deny = false;
    const lexical = vi.fn(() => []);
    const { client } = makeFakeSupabase({ tech_decisions: [row] }, {}, {
      mark_erasure_coverage_unknown: () => !deny,
      match_project_fact_vectors: () => { deny = true; return [{ id: "v1", source_type: "fact", source_ref: row.id, similarity: 0.9 }]; },
      search_project_warm_facts: lexical,
    });
    const encodeMany = vi.fn(async () => [embedding]);
    await expect(retrieveSessionContext(opts, { makeClient: () => client, encode: async () => embedding, encodeMany })).rejects.toThrow(ErasureCoverageUnavailableError);
    expect(lexical).not.toHaveBeenCalled();
    expect(encodeMany).not.toHaveBeenCalled();
  });

  test("direct lexical RPC is guarded before dispatch even after successful earlier reads", async () => {
    let deny = false;
    const lexical = vi.fn(() => []);
    const { client } = makeFakeSupabase({ tech_decisions: [row] }, {}, {
      mark_erasure_coverage_unknown: () => !deny,
      match_project_fact_vectors: () => { deny = true; return []; },
      search_project_warm_facts: lexical,
    });
    const encodeMany = vi.fn(async () => [embedding]);
    await expect(retrieveSessionContext(opts, { makeClient: () => client, encode: async () => embedding, encodeMany })).rejects.toThrow(ErasureCoverageUnavailableError);
    expect(lexical).not.toHaveBeenCalled();
    expect(encodeMany).not.toHaveBeenCalled();
  });

  test("typed lexical denial propagates through both outer fallback catches", async () => {
    const { client } = makeFakeSupabase({ tech_decisions: [row] }, {}, {
      match_project_fact_vectors: () => [],
      search_project_warm_facts: () => { throw new ErasureCoverageUnavailableError(); },
    });
    const encodeMany = vi.fn(async () => [embedding]);
    await expect(retrieveSessionContext(opts, { makeClient: () => client, encode: async () => embedding, encodeMany })).rejects.toThrow(ErasureCoverageUnavailableError);
    expect(encodeMany).not.toHaveBeenCalled();
  });

  test("coverage denial during warm ranking cannot return already ranked vector facts", async () => {
    const { client } = makeFakeSupabase({ tech_decisions: [row] }, {}, {
      match_project_fact_vectors: () => [{ id: "v1", source_type: "fact", source_ref: row.id, similarity: 0.9 }],
      search_project_warm_facts: () => [],
    });
    await expect(retrieveSessionContext(opts, {
      makeClient: () => client, encode: async () => embedding,
      encodeMany: async () => { throw new ErasureCoverageUnavailableError(); },
    })).rejects.toThrow(ErasureCoverageUnavailableError);
  });
});
