import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeSupabase } from "./fake-supabase";
import { factToText } from "../../src/memory/promote";
import { retrieveSessionContext, taskFromBaton, type SessionContextOptions } from "../../scripts/session-start-context";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const base: SessionContextOptions = {
  projectRoot: "/project", boundRoot: "/project", orgId: ORG,
  supabaseUrl: "https://project.supabase.co", serviceKey: "secret-key",
  allowlistText: "# project hosts\nproject.supabase.co\n", task: "where is the auth decision?",
};

describe("session-start memory bridge", () => {
  test("rejects malformed project scope before creating a client", async () => {
    let calls = 0;
    expect(await retrieveSessionContext({ ...base, projectScope: "../vega" }, {
      makeClient: () => { calls++; throw new Error("must not connect"); },
      encode: () => { throw new Error("must not encode"); },
    })).toBeNull();
    expect(calls).toBe(0);
  });

  test("recent and semantic recall use only the operator-bound project", async () => {
    const row = (id: string, project_scope: string | null) => ({
      id, org_id: ORG, project_scope, is_suppressed: false,
      created_at: "2026-09-23T00:00:00Z", session_id: "s",
      confidence: 0.9, is_verified: true, promoted_to_t3: true,
      decision_text: id, domain: "auth",
    });
    const { client } = makeFakeSupabase({ tech_decisions: [row("orion", "orion"), row("vega", "vega"), row("legacy", null)] }, {}, {
      match_memory_vectors: () => [
        { id: "v1", source_type: "fact", source_ref: "vega", similarity: 0.99 },
        { id: "v2", source_type: "fact", source_ref: "orion", similarity: 0.9 },
      ],
      match_project_fact_vectors: () => [{ id: "v2", source_type: "fact", source_ref: "orion", similarity: 0.9 }],
    });
    const deps = { makeClient: () => client, encode: async () => new Array(384).fill(0) };
    const bound = JSON.parse((await retrieveSessionContext({ ...base, projectScope: "orion" }, deps)) as string);
    expect(bound.recentFacts.map((fact: { id: string }) => fact.id)).toEqual(["orion"]);
    expect(bound.relevantFacts.map((fact: { id: string }) => fact.id)).toEqual(["orion"]);
    const legacy = JSON.parse((await retrieveSessionContext({ ...base, task: "" }, deps)) as string);
    expect(legacy.recentFacts.map((fact: { id: string }) => fact.id)).toEqual(["legacy"]);
  });

  test("finds two older unpromoted warm facts beyond the recent three in the bound project", async () => {
    const row = (id: string, project_scope: string | null, day: number, is_suppressed = false) => ({
      id,
      org_id: ORG,
      project_scope,
      is_suppressed,
      created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
      session_id: "s",
      confidence: 0.9,
      is_verified: false,
      promoted_to_t3: false,
      decision_text: id,
      domain: "admin",
    });
    const { client } = makeFakeSupabase(
      {
        tech_decisions: [
          row("Clerk authentication", "orion", 10),
          row("__admin_session cookie", "orion", 11),
          row("dashboard color", "orion", 20),
          row("formatter", "orion", 21),
          row("logo", "orion", 22),
          row("foreign Clerk", "vega", 23),
          row("suppressed cookie", "orion", 24, true),
        ],
      },
      {},
      { match_project_fact_vectors: () => [] },
    );
    const output = await retrieveSessionContext(
      { ...base, projectScope: "orion", task: "Which auth provider and cookie protect admin?" },
      {
        makeClient: () => client,
        encode: async () => [1, ...new Array(383).fill(0)],
        encodeMany: async (texts) => texts.map((text) => (text.includes("Clerk") || text.includes("__admin_session") ? [1, ...new Array(383).fill(0)] : [0, 1, ...new Array(382).fill(0)])),
      },
    );
    const result = JSON.parse(output as string) as { recentFacts: { id: string }[]; relevantFacts: { id: string }[]; semanticStatus: string };
    expect(result.recentFacts.map((fact) => fact.id)).toEqual(["logo", "formatter", "dashboard color"]);
    expect(result.relevantFacts.map((fact) => fact.id)).toContain("Clerk authentication");
    expect(result.relevantFacts.map((fact) => fact.id)).toContain("__admin_session cookie");
    expect(result.relevantFacts).toHaveLength(3);
    expect(output).not.toContain("foreign Clerk");
    expect(output).not.toContain("suppressed cookie");
    expect(result.semanticStatus).toBe("complete");
  });

  test("keeps ranked warm facts when promoted-vector search fails", async () => {
    const { client } = makeFakeSupabase(
      {
        tech_decisions: [
          {
            id: "warm",
            org_id: ORG,
            project_scope: "orion",
            is_suppressed: false,
            created_at: "2026-09-20T00:00:00Z",
            session_id: "s",
            confidence: 0.9,
            is_verified: false,
            promoted_to_t3: false,
            decision_text: "recovery runbook",
            domain: "operations",
          },
        ],
      },
      {},
      {
        match_project_fact_vectors: () => {
          throw new Error("vector unavailable");
        },
      },
    );
    const output = await retrieveSessionContext(
      { ...base, projectScope: "orion" },
      {
        makeClient: () => client,
        encode: async () => [1, ...new Array(383).fill(0)],
        encodeMany: async () => [[1, ...new Array(383).fill(0)]],
      },
    );
    const result = JSON.parse(output as string) as { relevantFacts: { id: string }[]; semanticStatus: string };
    expect(result.relevantFacts.map((fact) => fact.id)).toEqual(["warm"]);
    expect(result.semanticStatus).toBe("partial");
  });

  test("keeps promoted facts when warm ranking fails and deduplicates a shared fact", async () => {
    const row = (id: string) => ({
      id,
      org_id: ORG,
      project_scope: "orion",
      is_suppressed: false,
      created_at: "2026-09-20T00:00:00Z",
      session_id: "s",
      confidence: 0.9,
      is_verified: true,
      promoted_to_t3: true,
      decision_text: "recovery runbook",
      domain: "operations",
    });
    const { client } = makeFakeSupabase(
      { tech_decisions: [row("shared")] },
      {},
      {
        match_project_fact_vectors: () => [{ id: "vector", source_type: "fact", source_ref: "shared", similarity: 0.8 }],
      },
    );
    const opts = { ...base, projectScope: "orion" };
    const failed = JSON.parse(
      (await retrieveSessionContext(opts, {
        makeClient: () => client,
        encode: async () => [1, ...new Array(383).fill(0)],
        encodeMany: async () => {
          throw new Error("warm encoder unavailable");
        },
      })) as string,
    ) as { relevantFacts: { id: string }[]; semanticStatus: string };
    expect(failed.relevantFacts.map((fact) => fact.id)).toEqual(["shared"]);
    expect(failed.semanticStatus).toBe("partial");
    const encoded: string[][] = [];
    const complete = JSON.parse(
      (await retrieveSessionContext(opts, {
        makeClient: () => client,
        encode: async () => [1, ...new Array(383).fill(0)],
        encodeMany: async (texts) => {
          encoded.push(texts);
          return texts.map(() => [1, ...new Array(383).fill(0)]);
        },
      })) as string,
    ) as { relevantFacts: { id: string }[]; semanticStatus: string };
    expect(complete.relevantFacts.map((fact) => fact.id)).toEqual(["shared"]);
    expect(complete.semanticStatus).toBe("complete");
    expect(encoded).toEqual([[factToText({
      id: "shared", fact_type: "TechDecision", created_at: "2026-09-20T00:00:00Z", session_id: "s",
      confidence: 0.9, is_verified: true, is_suppressed: false, decision_text: "recovery runbook", domain: "operations",
    })]]);
  });

  test("omits a stale decision from recent and relevant facts only when an active newer bound decision links it", async () => {
    const row = (id: string, day: number, supersedes_id?: string) => ({
      id, org_id: ORG, project_scope: "orion", is_suppressed: false,
      created_at: `2026-09-${day}T00:00:00Z`, session_id: "s", confidence: 0.9,
      is_verified: true, promoted_to_t3: true, decision_text: id, domain: "runtime",
      ...(supersedes_id ? { supersedes_id } : {}),
    });
    const { client } = makeFakeSupabase({ tech_decisions: [row("old", 23), row("new", 24, "old"), row("other", 22), row("other-2", 21)] }, {}, {
      match_project_fact_vectors: () => [
        { id: "v1", source_type: "fact", source_ref: "old", similarity: 0.99 },
        { id: "v2", source_type: "fact", source_ref: "new", similarity: 0.8 },
      ],
    });
    const output = await retrieveSessionContext({ ...base, projectScope: "orion" }, {
      makeClient: () => client, encode: async () => new Array(384).fill(0),
    });
    const result = JSON.parse(output as string) as { recentFacts: { id: string }[]; relevantFacts: { id: string }[] };
    expect(result.recentFacts.map((fact) => fact.id)).toEqual(["new", "other", "other-2"]);
    expect(result.relevantFacts.map((fact) => fact.id)).toEqual(["new"]);
  });

  test("keeps decisions when links are foreign, suppressed, backdated, or absent", async () => {
    const row = (id: string, project_scope: string, day: number, supersedes_id?: string, is_suppressed = false) => ({
      id, org_id: ORG, project_scope, is_suppressed,
      created_at: `2026-09-${day}T00:00:00Z`, session_id: "s", confidence: 0.9,
      is_verified: true, promoted_to_t3: true, decision_text: id, domain: "runtime",
      ...(supersedes_id ? { supersedes_id } : {}),
    });
    const { client } = makeFakeSupabase({ tech_decisions: [
      row("old", "orion", 20), row("unlinked", "orion", 23),
      row("foreign-new", "vega", 24, "old"), row("suppressed-new", "orion", 25, "old", true),
      row("backdated-new", "orion", 19, "old"), row("self", "orion", 18, "self"),
    ] }, {}, { match_project_fact_vectors: () => [{ id: "v", source_type: "fact", source_ref: "old", similarity: 0.9 }] });
    const output = await retrieveSessionContext({ ...base, projectScope: "orion" }, {
      makeClient: () => client, encode: async () => new Array(384).fill(0),
    });
    const result = JSON.parse(output as string) as { recentFacts: { id: string }[]; relevantFacts: { id: string }[] };
    expect(result.recentFacts.map((fact) => fact.id)).toContain("old");
    expect(result.relevantFacts.map((fact) => fact.id)).toContain("old");
    expect(output).not.toContain("foreign-new");
    expect(output).not.toContain("suppressed-new");
  });

  test("allows only the exact allowlisted local API origin", async () => {
    const local = { ...base, supabaseUrl: "http://127.0.0.1:54321/", allowlistText: "127.0.0.1", task: "" };
    const { client } = makeFakeSupabase();
    let calls = 0;
    const deps = {
      makeClient: (_url: string, _key: string) => { calls++; return client; },
      encode: () => { throw new Error("must not encode without a task"); },
    };
    expect(await retrieveSessionContext(local, deps)).toContain('"recentFacts":[]');
    expect(calls).toBe(1);
    for (const url of [
      "http://localhost:54321/", "http://127.0.0.1:54322/",
      "http://127.0.0.1:54321/rest/v1/", "http://user@127.0.0.1:54321/",
      "http://127.0.0.1.evil.test:54321/", "http://project.supabase.co/",
    ]) {
      expect(await retrieveSessionContext({ ...local, supabaseUrl: url }, deps)).toBeNull();
    }
    expect(calls).toBe(1);
  });

  test("missing or mismatched binding and disallowed host make no client call", async () => {
    const invalid = [
      { boundRoot: "/other" }, { orgId: "not-a-uuid" }, { serviceKey: "" },
      { supabaseUrl: "https://elsewhere.example" }, { supabaseUrl: "http://project.supabase.co" },
      { supabaseUrl: "https://project.supabase.co:8443" }, { supabaseUrl: "https://project.supabase.co/other" },
    ];
    for (const change of invalid) {
      let calls = 0;
      const output = await retrieveSessionContext({ ...base, ...change }, {
        makeClient: () => { calls++; throw new Error("network should not be reached"); },
        encode: () => { throw new Error("model should not be reached"); },
      });
      expect(output).toBeNull();
      expect(calls).toBe(0);
    }
  });

  test("injects bounded typed recent and semantic facts from only the bound organization", async () => {
    const row = (id: string, org_id: string, is_suppressed = false) => ({
      id, org_id, project_scope: null, is_suppressed, created_at: "2026-09-23T00:00:00Z", session_id: "s",
      confidence: 0.9, is_verified: true, promoted_to_t3: true,
      decision_text: id === "active" ? "use RS256" : "do not inject", domain: "auth",
    });
    const { client } = makeFakeSupabase({ tech_decisions: [
      row("active", ORG), row("suppressed", ORG, true), row("foreign", OTHER),
    ] }, {}, {
      match_project_fact_vectors: () => [
        { id: "v1", source_type: "fact", source_ref: "active", similarity: 0.9 },
        { id: "v2", source_type: "fact", source_ref: "suppressed", similarity: 0.8 },
        { id: "v3", source_type: "fact", source_ref: "foreign", similarity: 0.7 },
      ],
    });
    const queries: string[] = [];
    const output = await retrieveSessionContext(base, {
      makeClient: () => client as SupabaseClient,
      encode: async (query) => { queries.push(query); return new Array(384).fill(0); },
    });
    expect(queries).toEqual([base.task]);
    const parsed = JSON.parse(output as string) as { recentFacts: { id: string }[]; relevantFacts: { id: string }[]; source: string; semanticStatus: string };
    expect(parsed.source).toBe("untrusted_memory_data");
    expect(parsed.semanticStatus).toBe("complete");
    expect(parsed.recentFacts.map((f) => f.id)).toEqual(["active"]);
    expect(parsed.relevantFacts.map((f) => f.id)).toEqual(["active"]);
    expect(output).not.toContain('"id":"suppressed"');
    expect(output).not.toContain('"id":"foreign"');
    expect(output).not.toContain("secret-key");
  });

  test("extracts only the next action from a baton and skips semantic search without it", async () => {
    expect(taskFromBaton("# Baton\n## Next action\nFix the cache.\nMore detail.\n## History\nIgnore this.")).toBe("Fix the cache. More detail.");
    const { client } = makeFakeSupabase();
    const output = await retrieveSessionContext({ ...base, task: "" }, {
      makeClient: () => client,
      encode: () => { throw new Error("must not encode an empty task"); },
    });
    expect(JSON.parse(output as string).relevantFacts).toEqual([]);
    expect(JSON.parse(output as string).semanticStatus).toBe("not_requested");
  });

  test("a missing local encoder is labelled without losing recent facts", async () => {
    const { client } = makeFakeSupabase({ tech_decisions: [{
      id: "active", org_id: ORG, project_scope: null, is_suppressed: false, created_at: "2026-09-23T00:00:00Z",
      session_id: "s", confidence: 0.9, is_verified: false, promoted_to_t3: false,
      decision_text: "x".repeat(800), domain: "auth",
    }] });
    const output = await retrieveSessionContext(base, {
      makeClient: () => client,
      encode: () => { throw new Error("model unavailable"); },
    });
    const parsed = JSON.parse(output as string) as { semanticStatus: string; recentFacts: { decision_text: string }[] };
    expect(parsed.semanticStatus).toBe("unavailable");
    expect(parsed.recentFacts[0]?.decision_text).toHaveLength(300);
  });
});
