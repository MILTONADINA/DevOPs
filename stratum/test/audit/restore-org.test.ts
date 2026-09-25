// Unit tests for the org restore's pure seams (parseArgs, validateBackup,
// stripGeneratedCols, restorePlan). The live insert is verified by the
// backup→delete→restore round-trip (see the commit's live-verification notes).

import { describe, test, expect, vi } from "vitest";
import { join } from "node:path";
import { parseArgs, validateBackup, stripGeneratedCols, restorePlan, decisionSupersessionUpdates, main, RESTORE_ORDER } from "../../scripts/restore-org";
import { ORG_SCOPED_TABLES, type BackupFile } from "../../scripts/backup-org";

test("real restore fails without credentials while dry run validates the file", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
  const dir = mkdtempSync(join(process.cwd(), "../.workflow/state/recovery-credential-"));
  const file = join(dir, "fixture.backup.json");
  const backup: BackupFile = {
    orgId: "00000000-0000-0000-0000-000000000001",
    exportedAt: "2026-09-24T00:00:00Z",
    tables: Object.fromEntries([["organizations", [{ id: "00000000-0000-0000-0000-000000000001" }]], ...ORG_SCOPED_TABLES.map((table) => [table, []]), ["pruning_logs", []]]),
  };
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  try {
    writeFileSync(file, JSON.stringify(backup));
    for (const missing of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] as const) {
      process.env["SUPABASE_URL"] = "http://127.0.0.1:54321";
      process.env["SUPABASE_SERVICE_KEY"] = "test-only";
      delete process.env[missing];
      expect(await main(["--file", file, "--dry-run"])).toBe(0);
      expect(await main(["--file", file])).toBe(1);
    }
  } finally {
    if (url !== undefined) process.env["SUPABASE_URL"] = url;
    else delete process.env["SUPABASE_URL"];
    if (key !== undefined) process.env["SUPABASE_SERVICE_KEY"] = key;
    else delete process.env["SUPABASE_SERVICE_KEY"];
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseArgs", () => {
  test("defaults + flags", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, keepKeyState: false });
    expect(parseArgs(["--file", "/tmp/b.json", "--dry-run"])).toEqual({ file: "/tmp/b.json", dryRun: true, keepKeyState: false });
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
    expect(() => validateBackup({ ...ok, tables: { ...ok.tables, operational_references: undefined } })).toThrow(/predates operational_references/);
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
  test("rejects a conversation whose authenticating key is missing before restore", () => {
    const conversation = { id: "c1", org_id: "o1", kind: "conversation", conversation_key_id: "k1", project_scope: "orion" };
    const valid = { ...ok, tables: { ...ok.tables, api_keys: [{ id: "k1", org_id: "o1" }], sessions: [conversation] } };
    expect(validateBackup(valid)).toBe(valid);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, api_keys: [] } })).toThrow(/conversation.*key/i);
  });
  test("rejects missing, malformed, or duplicated decision references before restore", () => {
    const old = { id: "d1", org_id: "o1", project_scope: "orion", created_at: "2026-09-20T00:00:00Z", supersedes_id: null };
    const newer = {
      id: "d2", org_id: "o1", project_scope: "orion", created_at: "2026-09-21T00:00:00Z", supersedes_id: "d1",
      supersession_reviewer: "operator@example.test",
      supersession_evidence: "Reviewed decision replaces the earlier runtime choice.",
      supersession_reviewed_at: "2026-09-24T00:00:00Z",
    };
    const valid = { ...ok, tables: { ...ok.tables, tech_decisions: [newer, old] } };
    expect(validateBackup(valid)).toBe(valid);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [newer] } })).toThrow(/supersedes.*missing/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [{ ...newer, supersedes_id: 42 }, old] } })).toThrow(/supersedes.*invalid/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [newer, old, old] } })).toThrow(/duplicate.*decision/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [{ ...newer, supersession_evidence: null }, old] } })).toThrow(/review evidence/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [{ ...newer, project_scope: "vega" }, old] } })).toThrow(/supersedes.*project/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [{ ...newer, created_at: old.created_at }, old] } })).toThrow(/supersedes.*newer/i);
    expect(() => validateBackup({ ...valid, tables: { ...valid.tables, tech_decisions: [newer, { ...newer, id: "d3" }, old] } })).toThrow(/duplicate.*successor/i);
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
  test("inserts decisions before restoring a reviewed forward supersession", () => {
    const decisions = [
      {
        id: "d2", org_id: "o1", supersedes_id: "d1", decision_text: "newer",
        supersession_reviewer: "operator@example.test",
        supersession_evidence: "Reviewed decision replaces the earlier runtime choice.",
        supersession_reviewed_at: "2026-09-24T00:00:00Z",
      },
      { id: "d1", org_id: "o1", supersedes_id: null, decision_text: "older" },
    ];
    const backup: BackupFile = { orgId: "o1", exportedAt: "t", tables: { tech_decisions: decisions } };
    expect(restorePlan(backup)).toEqual([
      {
        table: "tech_decisions",
        rows: [
          { ...decisions[0], supersedes_id: null, supersession_reviewer: null, supersession_evidence: null, supersession_reviewed_at: null },
          decisions[1],
        ],
      },
    ]);
    expect(decisionSupersessionUpdates(backup)).toEqual([
      {
        id: "d2", supersedes_id: "d1", supersession_reviewer: "operator@example.test",
        supersession_evidence: "Reviewed decision replaces the earlier runtime choice.",
        supersession_reviewed_at: "2026-09-24T00:00:00Z",
      },
    ]);
    expect(decisions[0].supersedes_id).toBe("d1");
  });
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
    expect(RESTORE_ORDER.indexOf("api_keys")).toBeLessThan(RESTORE_ORDER.indexOf("sessions"));
    expect(RESTORE_ORDER.indexOf("function_changes")).toBeLessThan(RESTORE_ORDER.indexOf("audit_statuses"));
    expect(RESTORE_ORDER.indexOf("audit_conflicts")).toBeLessThan(RESTORE_ORDER.indexOf("audit_statuses"));
  });
});

// PB-64 and PB-65 (2026-09-25): a restore cannot know about revocations made after the backup, so API
// keys come back inactive unless the operator asks otherwise; invoice claims are part of the backup.
describe("backup and restore hardening (PB-64, PB-65)", () => {
  const base = (keys: unknown[]): BackupFile => ({
    orgId: "o1",
    exportedAt: "2026-09-25T00:00:00Z",
    tables: Object.fromEntries([["organizations", [{ id: "o1" }]], ...ORG_SCOPED_TABLES.map((table) => [table, table === "api_keys" ? keys : []]), ["pruning_logs", []]]),
  });

  test("restores API keys inactive by default, whatever the backup says", () => {
    const plan = restorePlan(base([{ id: "k1", org_id: "o1", key_hash: "h1", name: "ci", is_active: true }, { id: "k2", org_id: "o1", key_hash: "h2", name: "old", is_active: false }]));
    const keys = plan.find((p) => p.table === "api_keys")!.rows as { is_active: boolean }[];
    expect(keys.map((k) => k.is_active)).toEqual([false, false]);
  });

  test("--keep-key-state restores each key's backed-up state", () => {
    expect(parseArgs(["--file", "b.json", "--keep-key-state"]).keepKeyState).toBe(true);
    const plan = restorePlan(base([{ id: "k1", org_id: "o1", key_hash: "h1", name: "ci", is_active: true }]), { keepKeyState: true });
    expect((plan.find((p) => p.table === "api_keys")!.rows[0] as { is_active: boolean }).is_active).toBe(true);
  });

  test("invoice_send_claims is backed up and restored right after invoices", () => {
    expect(ORG_SCOPED_TABLES).toContain("invoice_send_claims");
    expect(RESTORE_ORDER.indexOf("invoice_send_claims")).toBe(RESTORE_ORDER.indexOf("invoices") + 1);
  });
});
