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
    // Seed in REVERSE chronological insertion order so the oldest-first assertion is
    // sensitive to the actual ordering (the fake's order() sorts faithfully now): if
    // the sort were dropped, the output would be [new, old], failing this test.
    const { client } = makeFakeSupabase({
      tech_decisions: [
        td({ id: "new-unpromoted", created_at: "2026-05-03T00:00:00Z", decision_text: "new" }),
        td({ id: "already-promoted", created_at: "2026-05-02T00:00:00Z", decision_text: "done", promoted_to_t3: true }),
        td({ id: "old-unpromoted", created_at: "2026-05-01T00:00:00Z", decision_text: "old" }),
      ],
    });
    const wm = createWarmMemory(client);
    const facts = await wm.queryUnpromoted("o1");
    expect(facts.map((f) => f.id)).toEqual(["old-unpromoted", "new-unpromoted"]); // promoted excluded; oldest-first
  });

  test("markPromoted is org-scoped: a colliding id in ANOTHER org is NOT marked", async () => {
    // Both rows share id "t1" — they differ only by org. Without the .eq('org_id')
    // filter, marking by id alone would touch BOTH; this asserts only the o1 row flips.
    const { client, store } = makeFakeSupabase({
      tech_decisions: [
        td({ id: "t1", org_id: "o1", session_id: "s-o1", promoted_to_t3: false }),
        td({ id: "t1", org_id: "o2", session_id: "s-o2", promoted_to_t3: false }), // SAME id, different org
      ],
    });
    const wm = createWarmMemory(client);
    const facts: AnyFact[] = [
      { id: "t1", created_at: "2026-05-01T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: false, is_suppressed: false, fact_type: "TechDecision", decision_text: "d", domain: "db" },
    ];
    expect(await wm.markPromoted(facts, "o1")).toBe(1);
    const rows = store["tech_decisions"]!;
    expect(rows.find((r) => r["org_id"] === "o1")!["promoted_to_t3"]).toBe(true); // o1 row marked
    expect(rows.find((r) => r["org_id"] === "o2")!["promoted_to_t3"]).toBe(false); // o2 row untouched (org-scoped)
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
