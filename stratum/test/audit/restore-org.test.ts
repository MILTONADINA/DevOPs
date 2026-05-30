// Unit tests for the org restore's pure seams (parseArgs, validateBackup,
// stripGeneratedCols, restorePlan). The live insert is verified by the
// backup→delete→restore round-trip (see the commit's live-verification notes).

import { describe, test, expect } from "vitest";
import { parseArgs, validateBackup, stripGeneratedCols, restorePlan, RESTORE_ORDER } from "../../scripts/restore-org";
import type { BackupFile } from "../../scripts/backup-org";

describe("parseArgs", () => {
  test("defaults + flags", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(["--file", "/tmp/b.json", "--dry-run"])).toEqual({ file: "/tmp/b.json", dryRun: true });
  });
});

describe("validateBackup", () => {
  const ok: BackupFile = { orgId: "o1", exportedAt: "t", tables: { organizations: [{ id: "o1" }] } };
  test("accepts a well-formed backup", () => {
    expect(validateBackup(ok)).toBe(ok);
  });
  test("rejects malformed inputs (fail-loud, never restore garbage)", () => {
    expect(() => validateBackup(null)).toThrow(/not an object/);
    expect(() => validateBackup({ tables: {} })).toThrow(/orgId/);
    expect(() => validateBackup({ orgId: "o1" })).toThrow(/tables/);
    expect(() => validateBackup({ orgId: "o1", tables: { organizations: [] } })).toThrow(/no organizations/);
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
        organizations: [{ id: "o1" }],
        sessions: [{ id: "s1" }],
        knowledge_entities: [{ id: "n1" }, { id: "n2" }],
        todos: [], // empty → skipped
      },
    };
    const plan = restorePlan(backup);
    const tables = plan.map((p) => p.table);
    expect(tables).toEqual(["organizations", "sessions", "knowledge_entities", "knowledge_edges"]); // FK order; todos dropped
    // organizations before sessions before entities before edges (the FK chain)
    expect(tables.indexOf("organizations")).toBeLessThan(tables.indexOf("sessions"));
    expect(tables.indexOf("knowledge_entities")).toBeLessThan(tables.indexOf("knowledge_edges"));
  });

  test("RESTORE_ORDER puts organizations first and edges after entities", () => {
    expect(RESTORE_ORDER[0]).toBe("organizations");
    expect(RESTORE_ORDER.indexOf("knowledge_entities")).toBeLessThan(RESTORE_ORDER.indexOf("knowledge_edges"));
    expect(RESTORE_ORDER.indexOf("sessions")).toBeLessThan(RESTORE_ORDER.indexOf("audit_conflicts"));
  });
});
