import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeFakeSupabase } from "./fake-supabase";
import { retrieveSessionContext, taskFromBaton, type SessionContextOptions } from "../../scripts/session-start-context";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const base: SessionContextOptions = {
  projectRoot: "/project", boundRoot: "/project", orgId: ORG,
  supabaseUrl: "https://project.supabase.co", serviceKey: "secret-key",
  allowlistText: "# project hosts\nproject.supabase.co\n", task: "where is the auth decision?",
};

describe("session-start memory bridge", () => {
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
      id, org_id, is_suppressed, created_at: "2026-09-23T00:00:00Z", session_id: "s",
      confidence: 0.9, is_verified: true, promoted_to_t3: true,
      decision_text: id === "active" ? "use RS256" : "do not inject", domain: "auth",
    });
    const { client } = makeFakeSupabase({ tech_decisions: [
      row("active", ORG), row("suppressed", ORG, true), row("foreign", OTHER),
    ] }, {}, {
      match_memory_vectors: () => [
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
      id: "active", org_id: ORG, is_suppressed: false, created_at: "2026-09-23T00:00:00Z",
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
