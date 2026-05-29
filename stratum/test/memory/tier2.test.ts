// Unit tests for the Tier-2 warm-memory adapter. The pure projection
// (tableForFactType / factToRow / rowToFact) is tested directly; the
// persist/queryRecent logic is tested against a fake Supabase client so it runs
// in CI with no credentials. The LIVE round-trip is verified separately by
// scripts/verify-tier2.ts (gated on SUPABASE_SERVICE_KEY).

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FACT_TABLES,
  TABLE_FACT_TYPES,
  tableForFactType,
  factToRow,
  rowToFact,
  createWarmMemory,
} from "../../src/memory/warm/tier2";
import type { AnyFact, TechDecisionFact, FunctionChangeFact, TodoFact } from "../../src/types/facts";

const base = { id: "11111111-1111-1111-1111-111111111111", created_at: "2026-05-29T00:00:00Z", session_id: "logical-session", confidence: 0.9, is_verified: false, is_suppressed: false } as const;
const td: TechDecisionFact = { ...base, fact_type: "TechDecision", decision_text: "use Cloudflare Workers", domain: "deploy", rationale: "edge latency" };
const fc: FunctionChangeFact = { ...base, fact_type: "FunctionChange", old_name: "getUser", change_type: "deprecated" }; // new_name absent
const ctx = { orgId: "org-uuid", sessionId: "real-session-uuid" };

describe("Tier-2 table routing", () => {
  test("FACT_TABLES + reverse map are consistent for all 5 types", () => {
    expect(Object.keys(FACT_TABLES)).toHaveLength(5);
    for (const [ft, table] of Object.entries(FACT_TABLES)) {
      expect(tableForFactType(ft as AnyFact["fact_type"])).toBe(table);
      expect(TABLE_FACT_TYPES[table]).toBe(ft);
    }
  });

  test("tableForFactType throws on an unmapped type (defensive)", () => {
    expect(() => tableForFactType("Bogus" as AnyFact["fact_type"])).toThrow(/no warm-memory table/i);
  });
});

describe("factToRow (write projection)", () => {
  test("drops the fact_type discriminator (not a column)", () => {
    const { row } = factToRow(td, ctx);
    expect(row["fact_type"]).toBeUndefined();
  });

  test("forces org_id + session_id from trusted ctx (forgery-safe)", () => {
    // a fact carrying its own logical session_id AND a forged org_id must lose to ctx.
    const forged = { ...td, org_id: "FORGED-ORG" } as AnyFact;
    const { table, row } = factToRow(forged, ctx);
    expect(table).toBe("tech_decisions");
    expect(row["session_id"]).toBe("real-session-uuid"); // ctx wins over fact.session_id
    expect(row["org_id"]).toBe("org-uuid"); // ctx wins over forged org_id
  });

  test("drops undefined optionals (→ SQL NULL, not explicit null)", () => {
    const { row } = factToRow(fc, ctx);
    expect("new_name" in row).toBe(false); // absent optional omitted entirely
    expect(row["old_name"]).toBe("getUser");
    expect(row["change_type"]).toBe("deprecated");
    expect(row["confidence"]).toBe(0.9);
  });
});

describe("rowToFact (read projection)", () => {
  test("reattaches fact_type, strips org_id + promoted_to_t3, validates", () => {
    const dbRow = { id: base.id, created_at: base.created_at, session_id: "real-session-uuid", org_id: "org-uuid", promoted_to_t3: false, confidence: 0.95, is_verified: false, is_suppressed: false, decision_text: "d", domain: "db", rationale: null, supersedes_id: null };
    const fact = rowToFact("tech_decisions", dbRow);
    expect(fact).not.toBeNull();
    expect(fact!.fact_type).toBe("TechDecision");
    expect((fact as TechDecisionFact).decision_text).toBe("d");
    expect((fact as Record<string, unknown>)["org_id"]).toBeUndefined();
    expect((fact as Record<string, unknown>)["promoted_to_t3"]).toBeUndefined();
    // NULL optional columns coerced to absent (Zod .optional() rejects null)
    expect((fact as TechDecisionFact).rationale).toBeUndefined();
  });

  test("returns null for an unknown table", () => {
    expect(rowToFact("not_a_table", { id: "x" })).toBeNull();
  });

  test("returns null (FAIL-CLOSED) for a row that violates the schema", () => {
    const bad = { id: base.id, created_at: base.created_at, session_id: "s", confidence: 1.5, is_verified: false, is_suppressed: false, decision_text: "d", domain: "db" };
    expect(rowToFact("tech_decisions", bad)).toBeNull(); // confidence > 1
  });
});

// ── Fake Supabase client (chainable, no `this`) ────────────────────────────────
function makeFakeClient(
  store: Record<string, Record<string, unknown>[]> = {},
  faults: { insertError?: Set<string>; selectError?: Set<string> } = {},
): { client: SupabaseClient; inserted: Record<string, Record<string, unknown>[]> } {
  const inserted: Record<string, Record<string, unknown>[]> = {};
  const client = {
    from(table: string) {
      return {
        insert(rows: Record<string, unknown>[]) {
          inserted[table] = [...(inserted[table] ?? []), ...rows];
          return Promise.resolve({ data: null, error: faults.insertError?.has(table) ? { message: `insert failed: ${table}` } : null });
        },
        select(_cols: string) {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return builder;
            },
            order(_c: string, _o: unknown) {
              return builder;
            },
            limit(n: number) {
              if (faults.selectError?.has(table)) return Promise.resolve({ data: null, error: { message: `select failed: ${table}` } });
              let rows = store[table] ?? [];
              for (const [c, v] of Object.entries(filters)) rows = rows.filter((r) => r[c] === v);
              return Promise.resolve({ data: rows.slice(0, n), error: null });
            },
          };
          return builder;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, inserted };
}

describe("createWarmMemory.persist (fake client)", () => {
  test("groups by table, batch-inserts, counts persisted; trusted FKs applied", async () => {
    const { client, inserted } = makeFakeClient();
    const wm = createWarmMemory(client);
    const result = await wm.persist([td, fc], ctx);
    expect(result.persisted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(inserted["tech_decisions"]).toHaveLength(1);
    expect(inserted["function_changes"]).toHaveLength(1);
    expect(inserted["tech_decisions"]![0]!["org_id"]).toBe("org-uuid");
    expect(inserted["tech_decisions"]![0]!["session_id"]).toBe("real-session-uuid");
  });

  test("FAIL-CLOSED: invalid facts are skipped, not written", async () => {
    const { client, inserted } = makeFakeClient();
    const wm = createWarmMemory(client);
    const bad = { ...td, confidence: 1.5 } as AnyFact; // out of [0,1]
    const result = await wm.persist([td, bad], ctx);
    expect(result.persisted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(inserted["tech_decisions"]).toHaveLength(1); // only the valid one
  });

  test("records a per-table error when an insert fails (other tables still persist)", async () => {
    const { client } = makeFakeClient({}, { insertError: new Set(["tech_decisions"]) });
    const wm = createWarmMemory(client);
    const result = await wm.persist([td, fc], ctx);
    expect(result.persisted).toBe(1); // function_changes succeeded
    expect(result.errors).toEqual([{ table: "tech_decisions", message: "insert failed: tech_decisions" }]);
  });

  test("empty input → nothing written", async () => {
    const { client, inserted } = makeFakeClient();
    const wm = createWarmMemory(client);
    const result = await wm.persist([], ctx);
    expect(result).toEqual({ persisted: 0, skipped: 0, errors: [] });
    expect(Object.keys(inserted)).toHaveLength(0);
  });
});

describe("createWarmMemory.queryRecent (fake client)", () => {
  const rowOf = (overrides: Record<string, unknown>) => ({ id: "11111111-1111-1111-1111-111111111111", created_at: "2026-05-29T00:00:00Z", org_id: "org-uuid", session_id: "s1", confidence: 0.8, is_verified: false, is_suppressed: false, promoted_to_t3: false, ...overrides });

  test("merges across tables, newest-first, caps at limit", async () => {
    const store = {
      tech_decisions: [rowOf({ created_at: "2026-05-20T00:00:00Z", decision_text: "old", domain: "d" })],
      todos: [rowOf({ created_at: "2026-05-28T00:00:00Z", description: "newest", status: "open" })],
      function_changes: [rowOf({ created_at: "2026-05-25T00:00:00Z", old_name: "g", change_type: "deprecated" })],
    };
    const { client } = makeFakeClient(store);
    const wm = createWarmMemory(client);
    const facts = await wm.queryRecent("org-uuid", { limit: 2 });
    expect(facts).toHaveLength(2);
    expect(facts[0]!.fact_type).toBe("Todo"); // 05-28 newest
    expect(facts[0]!.created_at).toBe("2026-05-28T00:00:00Z");
    expect(facts[1]!.fact_type).toBe("FunctionChange"); // 05-25 next
  });

  test("filters by sessionId when provided", async () => {
    const store = {
      todos: [rowOf({ session_id: "s1", description: "mine", status: "open" }), rowOf({ session_id: "s2", description: "other", status: "open" })],
    };
    const { client } = makeFakeClient(store);
    const wm = createWarmMemory(client);
    const facts = await wm.queryRecent("org-uuid", { sessionId: "s1" });
    expect(facts).toHaveLength(1);
    expect((facts[0] as TodoFact).description).toBe("mine");
  });

  test("throws when a table read fails (no silent partial)", async () => {
    const { client } = makeFakeClient({}, { selectError: new Set(["todos"]) });
    const wm = createWarmMemory(client);
    await expect(wm.queryRecent("org-uuid")).rejects.toThrow(/queryRecent failed.*todos/);
  });
});
