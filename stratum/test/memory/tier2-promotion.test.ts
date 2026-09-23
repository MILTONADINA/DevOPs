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
  test("queryUnpromoted excludes promoted facts + returns oldest-first ACROSS tables", async () => {
    // Two tables with INTERLEAVED timestamps so the cross-table merge-sort is
    // load-bearing: the correct oldest-first order interleaves tech_decisions and
    // todos, so if the impl merge-sort were dropped the output would be in
    // table-iteration order ([d-old, d-new, todo-mid]) — failing this assertion.
    const todoRow = (o: Record<string, unknown>) => ({ org_id: "o1", session_id: "s1", confidence: 0.8, is_verified: false, is_suppressed: false, promoted_to_t3: false, status: "open", ...o });
    const { client } = makeFakeSupabase({
      tech_decisions: [
        td({ id: "d-new", created_at: "2026-05-05T00:00:00Z", decision_text: "new" }),
        td({ id: "d-promoted", created_at: "2026-05-02T00:00:00Z", decision_text: "done", promoted_to_t3: true }),
        td({ id: "d-old", created_at: "2026-05-01T00:00:00Z", decision_text: "old" }),
      ],
      todos: [todoRow({ id: "todo-mid", created_at: "2026-05-03T00:00:00Z", description: "mid" })],
    });
    const wm = createWarmMemory(client);
    const facts = await wm.queryUnpromoted("o1");
    expect(facts.map((f) => f.id)).toEqual(["d-old", "todo-mid", "d-new"]); // promoted excluded; oldest-first across tables
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

describe("getFactsByRefs (content-free vector-hit → typed-fact resolution)", () => {
  const todoRow = (o: Record<string, unknown>) => ({ created_at: "2026-05-01T00:00:00Z", org_id: "o1", session_id: "s1", confidence: 0.8, is_verified: false, is_suppressed: false, promoted_to_t3: false, status: "open", ...o });

  test("resolves facts by id ACROSS tables, org-scoped; unknown ids absent", async () => {
    const { client } = makeFakeSupabase({
      tech_decisions: [td({ id: "d1", decision_text: "use Supabase" })],
      todos: [todoRow({ id: "todo1", description: "ship adapter" })],
    });
    const map = await createWarmMemory(client).getFactsByRefs("o1", ["d1", "todo1", "missing"]);
    expect(map.size).toBe(2);
    expect(map.get("d1")?.fact_type).toBe("TechDecision");
    expect(map.get("todo1")?.fact_type).toBe("Todo");
    expect(map.has("missing")).toBe(false);
  });

  test("does NOT resolve a same-id row from another org (org-scoped)", async () => {
    const { client } = makeFakeSupabase({
      tech_decisions: [td({ id: "t1", org_id: "o1", decision_text: "o1-decision" }), td({ id: "t1", org_id: "o2", decision_text: "o2-decision" })],
    });
    const map = await createWarmMemory(client).getFactsByRefs("o1", ["t1"]);
    expect(map.size).toBe(1);
    expect((map.get("t1") as { decision_text?: string }).decision_text).toBe("o1-decision");
  });

  test("empty refs → empty map (no query)", async () => {
    const { client } = makeFakeSupabase();
    expect((await createWarmMemory(client).getFactsByRefs("o1", [])).size).toBe(0);
  });

  test("throws (no silent partial) when a table read fails", async () => {
    const { client } = makeFakeSupabase({}, { selectError: new Set(["tech_decisions"]) });
    await expect(createWarmMemory(client).getFactsByRefs("o1", ["x"])).rejects.toThrow(/getFactsByRefs failed.*tech_decisions/);
  });
});
