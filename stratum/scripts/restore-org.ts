/**
 * Org restore — re-insert a `npm run backup` JSON export (v0.8.x: "backup tested", write half).
 *
 * The complement to backup-org.ts: read a backup file and re-insert its rows into Supabase in
 * FK-dependency order, preserving UUIDs so every cross-table reference stays valid. Intended for
 * disaster recovery into a CLEAN target (or after the org was deleted) — a plain insert that
 * FAILS LOUD on any error (a PK collision means the org still exists; restore into an empty DB).
 *
 *   npm run restore -- --file <path> [--dry-run]
 *
 * billing_records is append-only with GENERATED columns (token_delta/cost_delta_usd/cq_fee_usd);
 * those are stripped before insert (the DB recomputes them). Self-referential nullable FKs
 * (tech_decisions.supersedes_id) are assumed null (the extractor strips them); a populated
 * forward self-reference within one table is a documented limitation.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ORG_SCOPED_TABLES, type BackupFile } from "./backup-org";

/** Insert order: every parent table before its children (FK-safe). */
export const RESTORE_ORDER = [
  "organizations",
  "developers",
  "org_config",
  "sessions",
  "function_changes",
  "tech_decisions",
  "policy_updates",
  "todos",
  "variable_changes",
  "pruning_logs",
  "billing_records",
  "invoices",
  "knowledge_entities",
  "knowledge_edges",
  "knowledge_entity_sessions",
  "knowledge_edge_sessions",
  "source_fact_links",
  "memory_vectors",
  "audit_conflicts",
  "audit_statuses",
  "api_keys",
] as const;

/** Columns the DB GENERATEs — must NOT be sent on insert (it recomputes them). */
const GENERATED_COLS: Record<string, string[]> = {
  billing_records: ["token_delta", "cost_delta_usd", "cq_fee_usd"],
};

interface Args {
  file?: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--file") out.file = argv[++i] ?? "";
    else if (tok === "--dry-run") out.dryRun = true;
  }
  return out;
}

/** Validate a parsed object is a BackupFile (fail-loud — never restore from a malformed file). */
export function validateBackup(obj: unknown): BackupFile {
  if (typeof obj !== "object" || obj === null) throw new Error("backup is not an object");
  const b = obj as Partial<BackupFile>;
  if (typeof b.orgId !== "string" || b.orgId === "") throw new Error("backup.orgId missing");
  if (typeof b.tables !== "object" || b.tables === null || Array.isArray(b.tables)) throw new Error("backup.tables missing");
  const orgRows = b.tables["organizations"];
  if (!Array.isArray(orgRows) || orgRows.length === 0) throw new Error("backup has no organizations row");
  if (orgRows.length !== 1 || (orgRows[0] as { id?: unknown } | null)?.id !== b.orgId) throw new Error("backup organization ID mismatch");
  const expected = new Set<string>(["organizations", ...ORG_SCOPED_TABLES, "pruning_logs"]);
  for (const table of expected) {
    if (!Array.isArray(b.tables[table])) throw new Error(`backup table ${table} missing or not an array`);
  }
  for (const table of Object.keys(b.tables)) {
    if (!expected.has(table)) throw new Error(`backup table ${table} is not supported by restore`);
  }
  const sourceLinks = b.tables["source_fact_links"];
  if (sourceLinks?.some((row) => (row as { org_id?: unknown } | null)?.org_id !== b.orgId)) {
    throw new Error("backup source link organization mismatch");
  }
  for (const table of ORG_SCOPED_TABLES) {
    if (b.tables[table]?.some((row) => (row as { org_id?: unknown } | null)?.org_id !== b.orgId)) {
      throw new Error(`backup table ${table} organization mismatch`);
    }
  }
  const sessionIds = new Set<string>();
  for (const row of b.tables["sessions"] ?? []) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") throw new Error("backup session ID missing");
    sessionIds.add(id);
  }
  if (
    b.tables["pruning_logs"]?.some((row) => {
      const id = (row as { session_id?: unknown } | null)?.session_id;
      return typeof id !== "string" || !sessionIds.has(id);
    })
  ) {
    throw new Error("backup pruning_logs session mismatch");
  }
  return b as BackupFile;
}

/** Strip GENERATED columns from a table's rows (pure; returns new row objects). */
export function stripGeneratedCols(table: string, rows: unknown[]): unknown[] {
  const drop = GENERATED_COLS[table];
  if (!drop || drop.length === 0) return rows;
  return rows.map((r) => {
    const copy = { ...(r as Record<string, unknown>) };
    for (const c of drop) delete copy[c];
    return copy;
  });
}

/** The ordered, non-empty insert plan (pure; testable). Tables absent/empty in the backup are skipped. */
export function restorePlan(backup: BackupFile): { table: string; rows: unknown[] }[] {
  const plan: { table: string; rows: unknown[] }[] = [];
  for (const table of RESTORE_ORDER) {
    const rows = backup.tables[table];
    if (Array.isArray(rows) && rows.length > 0) plan.push({ table, rows: stripGeneratedCols(table, rows) });
  }
  return plan;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.file === undefined || args.file === "") {
    out("usage: npm run restore -- --file <path> [--dry-run]");
    return 1;
  }

  let backup: BackupFile;
  try {
    backup = validateBackup(JSON.parse(readFileSync(args.file, "utf8")) as unknown);
  } catch (e) {
    out(`invalid backup file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const plan = restorePlan(backup);
  out(`Restore org ${backup.orgId}${backup.exportedAt ? ` (exported ${backup.exportedAt})` : ""}`);
  out("=".repeat(50));
  for (const { table, rows } of plan) out(`  ${table.padEnd(22)} ${rows.length}`);
  const total = plan.reduce((n, p) => n + p.rows.length, 0);
  out("-".repeat(50));

  if (args.dryRun) {
    out(`DRY RUN — would insert ${total} row(s) across ${plan.length} tables. Nothing written.`);
    return 0;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("restore failed: set SUPABASE_URL + SUPABASE_SERVICE_KEY to write.");
    return 1;
  }
  const client: SupabaseClient = createClient(url, key);

  let inserted = 0;
  for (const { table, rows } of plan) {
    if (table === "source_fact_links") {
      // Fact/File INSERT triggers may have recreated these links with fresh IDs.
      // Replace only this clean target org's generated links with the exact
      // backed-up rows, including their original IDs and timestamps.
      const cleared = await client.from(table).delete().eq("org_id", backup.orgId);
      if (cleared.error) throw new Error(`restore ${table} preparation failed: ${cleared.error.message}`);
    }
    // Inserting graph parents recreates their first session links via DB triggers.
    // Keep those links and add any later-session links from the backup.
    const conflict = table === "knowledge_entity_sessions" ? "org_id,entity_id,session_id" : table === "knowledge_edge_sessions" ? "org_id,edge_id,session_id" : undefined;
    const { error } = conflict ? await client.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: true }) : await client.from(table).insert(rows);
    if (error) throw new Error(`restore ${table} failed after ${inserted} row(s): ${error.message} (restore into a CLEAN target; a collision means the org still exists)`);
    inserted += rows.length;
  }
  if (Array.isArray(backup.tables["source_fact_links"]) && backup.tables["source_fact_links"].length === 0) {
    const cleared = await client.from("source_fact_links").delete().eq("org_id", backup.orgId);
    if (cleared.error) throw new Error(`restore empty source_fact_links failed: ${cleared.error.message}`);
  }
  out(`Restored ${inserted} row(s) across ${plan.length} tables for org ${backup.orgId}.`);
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("restore-org.ts") || entryPath.endsWith("restore-org.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`restore failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
