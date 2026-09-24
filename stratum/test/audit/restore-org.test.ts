// Unit tests for the org restore's pure seams (parseArgs, validateBackup,
// stripGeneratedCols, restorePlan). The live insert is verified by the
// backup→delete→restore round-trip (see the commit's live-verification notes).

import { describe, test, expect } from "vitest";
import { parseArgs, validateBackup, stripGeneratedCols, restorePlan, RESTORE_ORDER } from "../../scripts/restore-org";
import { ORG_SCOPED_TABLES, type BackupFile } from "../../scripts/backup-org";

describe("parseArgs", () => {
  test("defaults + flags", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(["--file", "/tmp/b.json", "--dry-run"])).toEqual({ file: "/tmp/b.json", dryRun: true });
  });
});

describe("validateBackup", () => {
  const ok: BackupFile = {
    orgId: "o1",
    exportedAt: "t",
    tables: Object.fromEntries([["organizations", [{ id: "o1" }]], ...ORG_SCOPED_TABLES.map((table) => [table, []]), ["pruning_logs", []]]),
  };
  test("accepts a well-formed backup", () => {
    expect(validateBackup(ok)).toBe(ok);
  });
  test("rejects malformed inputs (fail-loud, never restore garbage)", () => {
    expect(() => validateBackup(null)).toThrow(/not an object/);
    expect(() => validateBackup({ tables: {} })).toThrow(/orgId/);
    expect(() => validateBackup({ orgId: "o1" })).toThrow(/tables/);
    expect(() => validateBackup({ orgId: "o1", tables: { organizations: [] } })).toThrow(/no organizations/);
    expect(() => validateBackup({ orgId: "o1", tables: { organizations: [{ id: "o2" }] } })).toThrow(/organization ID/);
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, source_fact_links: [{ id: "l1", org_id: "o2" }] } })).toThrow(/source link organization/);
  });
  test("rejects missing, malformed, and unsupported tables before planning a restore", () => {
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, audit_statuses: undefined } })).toThrow(/audit_statuses/);
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, pruning_logs: undefined } })).toThrow(/pruning_logs/);
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, sessions: {} } })).toThrow(/sessions/);
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, future_table: [{ id: "x" }] } })).toThrow(/future_table/);
  });
  test("rejects foreign organization rows from every scoped table", () => {
    for (const table of ORG_SCOPED_TABLES) {
      const foreign = { ...ok, tables: { ...ok.tables, [table]: [{ id: "other", org_id: "o2" }] } };
      expect(() => validateBackup(foreign), table).toThrow(/organization mismatch/);
    }
  });
  test("rejects pruning logs for sessions outside the backup", () => {
    const valid = { ...ok, tables: { ...ok.tables, sessions: [{ id: "s1", org_id: "o1" }], pruning_logs: [{ id: "p1", session_id: "s1" }] } };
    expect(validateBackup(valid)).toBe(valid);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, pruning_logs: [{ id: "p2", session_id: "s2" }] } })).toThrow(/pruning_logs/);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, sessions: [{ org_id: "o1" }], pruning_logs: [{ id: "p2" }] } })).toThrow(/session/);
  });
});

describe("stripGeneratedCols", () => {
  test("removes billing GENERATED columns; leaves others untouched", () => {
    const rows = [{ id: "b1", original_tokens: 100, quarantined_tokens: 40, token_delta: 60, cost_delta_usd: 1.2, cq_fee_usd: 0.24, signed_hash: "h" }];
    const [r] = stripGeneratedCols("billing_records", rows) as Record<string, unknown>[];
    expect(r).not.toHaveProperty("token_delta");
    expect(r).not.toHaveProperty("cost_delta_usd");
    expect(r).not.toHaveProperty("cq_fee_usd");
    expect(r).toMatchObject({ id: "b1", original_tokens: 100, signed_hash: "h" }); // kept
  });
  test("non-generated tables pass through unchanged", () => {
    const rows = [{ id: "s1", model: "x" }];
    expect(stripGeneratedCols("sessions", rows)).toBe(rows);
  });
});

describe("restorePlan", () => {
  test("orders parents before children and skips empty/absent tables", () => {
    const backup: BackupFile = {
      orgId: "o1",
      exportedAt: "t",
      tables: {
        knowledge_edges: [{ id: "e1" }],
        knowledge_entity_sessions: [{ entity_id: "n1", session_id: "s1" }],
        knowledge_edge_sessions: [{ edge_id: "e1", session_id: "s1" }],
        source_fact_links: [{ id: "l1", file_entity_id: "n1" }],
        organizations: [{ id: "o1" }],
        sessions: [{ id: "s1" }],
        knowledge_entities: [{ id: "n1" }, { id: "n2" }],
        todos: [], // empty → skipped
      },
    };
    const plan = restorePlan(backup);
    const tables = plan.map((p) => p.table);
    expect(tables).toEqual(["organizations", "sessions", "knowledge_entities", "knowledge_edges", "knowledge_entity_sessions", "knowledge_edge_sessions", "source_fact_links"]); // FK order; todos dropped
    // organizations before sessions before entities before edges (the FK chain)
    expect(tables.indexOf("organizations")).toBeLessThan(tables.indexOf("sessions"));
    expect(tables.indexOf("knowledge_entities")).toBeLessThan(tables.indexOf("knowledge_edges"));
  });

  test("RESTORE_ORDER puts organizations first and edges after entities", () => {
    expect(new Set(RESTORE_ORDER)).toEqual(new Set(["organizations", ...ORG_SCOPED_TABLES, "pruning_logs"]));
    expect(RESTORE_ORDER[0]).toBe("organizations");
    expect(RESTORE_ORDER.indexOf("knowledge_entities")).toBeLessThan(RESTORE_ORDER.indexOf("knowledge_edges"));
    expect(RESTORE_ORDER.indexOf("knowledge_edges")).toBeLessThan(RESTORE_ORDER.indexOf("knowledge_entity_sessions"));
    expect(RESTORE_ORDER.indexOf("knowledge_edges")).toBeLessThan(RESTORE_ORDER.indexOf("knowledge_edge_sessions"));
    expect(RESTORE_ORDER.indexOf("knowledge_entities")).toBeLessThan(RESTORE_ORDER.indexOf("source_fact_links"));
    expect(RESTORE_ORDER.indexOf("function_changes")).toBeLessThan(RESTORE_ORDER.indexOf("source_fact_links"));
    expect(RESTORE_ORDER.indexOf("sessions")).toBeLessThan(RESTORE_ORDER.indexOf("audit_conflicts"));
    expect(RESTORE_ORDER.indexOf("function_changes")).toBeLessThan(RESTORE_ORDER.indexOf("audit_statuses"));
    expect(RESTORE_ORDER.indexOf("audit_conflicts")).toBeLessThan(RESTORE_ORDER.indexOf("audit_statuses"));
  });
});
