// Unit tests for the org backup's pure seams (parseArgs, summarize/total, filename).
// The live export (exportOrg → Supabase) is verified by `npm run backup` against a
// seeded throwaway org (see the commit's live-verification notes).

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseArgs, summarizeBackup, totalRows, backupFilename, exportOrg, main, ORG_SCOPED_TABLES, type BackupFile } from "../../scripts/backup-org";

test("specs/ops/payment-removal.md#REQ-9 — export reads every active table with scoped exact paging and never queries retired invoice tables", async () => {
  const active = ["organizations", "developers", "org_config", "sessions", "billing_records", "function_changes", "tech_decisions", "policy_updates", "todos", "variable_changes", "operational_references", "knowledge_entities", "knowledge_edges", "knowledge_entity_sessions", "knowledge_edge_sessions", "source_fact_links", "memory_vectors", "audit_conflicts", "audit_statuses", "api_keys", "pruning_logs"];
  const queried: string[] = [];
  const pages: [number, number][] = [];
  const usage = Array.from({ length: 1001 }, (_, i) => ({ id: `u${i}`, org_id: "o1", session_id: "s1" }));
  const rows: Record<string, unknown[]> = { organizations: [{ id: "o1" }], sessions: [{ id: "s1", org_id: "o1" }], billing_records: usage, pruning_logs: [{ id: "p1", session_id: "s1" }] };
  const client = {
    from(table: string) {
      expect(active, `unexpected export query: ${table}`).toContain(table);
      queried.push(table);
      let scoped = false;
      const order: string[] = [];
      const query = {
        select(columns: string, options: unknown) { expect(columns).toBe("*"); expect(options).toEqual({ count: "exact" }); return query; },
        eq(column: string, value: string) { expect(column).toBe(table === "organizations" ? "id" : "org_id"); expect(value).toBe("o1"); scoped = true; return query; },
        in(column: string, value: string[]) { expect(table).toBe("pruning_logs"); expect(column).toBe("session_id"); expect(value).toEqual(["s1"]); scoped = true; return query; },
        order(column: string, options: unknown) { expect(options).toEqual({ ascending: true }); order.push(column); return query; },
        async range(start: number, end: number) {
          expect(scoped).toBe(true);
          expect(order.length).toBeGreaterThan(0);
          if (table === "billing_records") { expect(order).toEqual(["id"]); pages.push([start, end]); }
          const data = rows[table] ?? [];
          return { data: data.slice(start, end + 1), count: data.length, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const backup = await exportOrg(client, "o1", "2026-10-03T00:00:00Z");
  expect(new Set(queried)).toEqual(new Set(active));
  expect(Object.keys(backup.tables).sort()).toEqual([...active].sort());
  expect(backup.tables["billing_records"]).toEqual(usage);
  expect(backup.tables["pruning_logs"]).toEqual(rows["pruning_logs"]);
  expect(pages).toEqual([[0, 499], [500, 999], [1000, 1499]]);
});

test("backup exits nonzero without database credentials", async () => {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  try {
    for (const missing of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] as const) {
      process.env["SUPABASE_URL"] = "http://127.0.0.1:54321";
      process.env["SUPABASE_SERVICE_KEY"] = "test-only";
      delete process.env[missing];
      expect(await main(["--org-id", "00000000-0000-0000-0000-000000000001"])).toBe(1);
    }
  } finally {
    if (url !== undefined) process.env["SUPABASE_URL"] = url;
    else delete process.env["SUPABASE_URL"];
    if (key !== undefined) process.env["SUPABASE_SERVICE_KEY"] = key;
    else delete process.env["SUPABASE_SERVICE_KEY"];
  }
});

test("org backup includes the per-fact audit statuses", () => {
  expect(ORG_SCOPED_TABLES).toContain("audit_statuses");
});

test("org backup includes both graph session provenance tables", () => {
  expect(ORG_SCOPED_TABLES).toContain("knowledge_entity_sessions");
  expect(ORG_SCOPED_TABLES).toContain("knowledge_edge_sessions");
});

test("org backup includes File-to-fact source links", () => {
  expect(ORG_SCOPED_TABLES).toContain("source_fact_links");
});

test("org backup includes operational references", () => {
  expect(ORG_SCOPED_TABLES).toContain("operational_references");
});

describe("parseArgs", () => {
  test("defaults: no org, no out, not pretty", () => {
    expect(parseArgs([])).toEqual({ pretty: false });
  });
  test("parses flags", () => {
    expect(parseArgs(["--org-id", "o1", "--out", "/tmp/b.json", "--pretty"])).toEqual({ orgId: "o1", out: "/tmp/b.json", pretty: true });
  });
  test("a flag missing its value does not crash", () => {
    expect(parseArgs(["--org-id"]).orgId).toBe("");
  });
});

describe("summarizeBackup / totalRows", () => {
  const b: BackupFile = {
    orgId: "o1",
    exportedAt: "2026-05-29T12:00:00.000Z",
    tables: { organizations: [{ id: "o1" }], sessions: [{ id: "s1" }, { id: "s2" }], todos: [], function_changes: [{ id: "f1" }] },
  };
  test("per-table counts", () => {
    const s = Object.fromEntries(summarizeBackup(b).map((r) => [r.table, r.rows]));
    expect(s).toEqual({ organizations: 1, sessions: 2, todos: 0, function_changes: 1 });
  });
  test("total rows across all tables", () => {
    expect(totalRows(b)).toBe(4);
  });
});

describe("backupFilename", () => {
  test("filesystem-safe (no colons/dots) + short org + .backup.json suffix", () => {
    const f = backupFilename("abcdef01-2222-3333-4444-555555555555", "2026-05-29T12:34:56.789Z");
    expect(f).toBe("stratum-backup-abcdef01-2026-05-29T12-34-56-789Z.backup.json");
    expect(f.includes(":")).toBe(false); // no colons (invalid in a Windows filename)
    expect(f.endsWith(".backup.json")).toBe(true);
  });
});
