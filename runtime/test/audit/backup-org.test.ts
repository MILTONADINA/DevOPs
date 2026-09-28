// Unit tests for the org backup's pure seams (parseArgs, summarize/total, filename).
// The live export (exportOrg → Supabase) is verified by `npm run backup` against a
// seeded throwaway org (see the commit's live-verification notes).

import { describe, test, expect } from "vitest";
import { parseArgs, summarizeBackup, totalRows, backupFilename, main, ORG_SCOPED_TABLES, type BackupFile } from "../../scripts/backup-org";

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
