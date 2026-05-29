// Unit tests for the Tier-2 promotion lifecycle (queryUnpromoted / markPromoted),
// which exercise the promoted_to_t3 column the nightly Tier-2→Tier-3 job uses. Against
// the shared fake Supabase client; the live SQL (incl. the created_at age filter) is
// verified via the Supabase MCP.

import { describe, test, expect } from "vitest";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { makeFakeSupabase } from "./fake-supabase";
import type { AnyFact } from "../../src/types/facts";

const td = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: "t1",
  created_at: "2026-05-01T00:00:00Z",
  org_id: "o1",
  session_id: "s1",
  confidence: 0.9,
  is_verified: false,
  is_suppressed: false,
  promoted_to_t3: false,
  decision_text: "d",
  domain: "db",
  ...overrides,
});

describe("Tier-2 promotion lifecycle", () => {
  test("queryUnpromoted returns only promoted_to_t3=false facts, oldest-first", async () => {
    const { client } = makeFakeSupabase({
      tech_decisions: [
        td({ id: "old-unpromoted", created_at: "2026-05-01T00:00:00Z", decision_text: "old" }),
        td({ id: "already-promoted", created_at: "2026-05-02T00:00:00Z", decision_text: "done", promoted_to_t3: true }),
        td({ id: "new-unpromoted", created_at: "2026-05-03T00:00:00Z", decision_text: "new" }),
      ],
    });
    const wm = createWarmMemory(client);
    const facts = await wm.queryUnpromoted("o1");
    expect(facts.map((f) => f.id)).toEqual(["old-unpromoted", "new-unpromoted"]); // promoted excluded; oldest-first
  });

  test("markPromoted sets promoted_to_t3=true on each fact's table row (by fact_type→table + id)", async () => {
    const { client, store } = makeFakeSupabase({ tech_decisions: [td({ id: "t1", promoted_to_t3: false })] });
    const wm = createWarmMemory(client);
    const facts: AnyFact[] = [
      { id: "t1", created_at: "2026-05-01T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: false, is_suppressed: false, fact_type: "TechDecision", decision_text: "d", domain: "db" },
    ];
    expect(await wm.markPromoted(facts)).toBe(1);
    expect(store["tech_decisions"]![0]!["promoted_to_t3"]).toBe(true);
  });

  test("queryUnpromoted throws (no silent partial) when a table read fails", async () => {
    const { client } = makeFakeSupabase({}, { selectError: new Set(["tech_decisions"]) });
    const wm = createWarmMemory(client);
    await expect(wm.queryUnpromoted("o1")).rejects.toThrow(/queryUnpromoted failed.*tech_decisions/);
  });

  test("empty org → no unpromoted facts", async () => {
    const { client } = makeFakeSupabase();
    const wm = createWarmMemory(client);
    expect(await wm.queryUnpromoted("o1")).toEqual([]);
  });
});
