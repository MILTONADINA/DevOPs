/**
 * Org-scoped logical backup / export (v0.8.x operator-readiness: "backup tested").
 *
 * Exports ALL of one org's rows across every org-scoped table to a single timestamped
 * JSON file — a portable, human-readable snapshot for disaster recovery, data portability,
 * and GDPR export. READ-ONLY (SELECT only — zero write risk); FREE; gated on Supabase creds.
 *
 *   npm run backup -- --org-id <uuid> [--out <path>] [--pretty]
 *
 * RESTORE is the documented follow-up, deliberately separate: billing_records is append-only
 * (a DELETE/UPDATE no-op rule) with GENERATED columns (token_delta/cost_delta/cq_fee), and the
 * cross-table FKs need dependency-ordered re-insertion — a careful write-path. This export half
 * is independently valuable and safe. Output lands in the gitignored `backups/` (may hold real
 * org data — never commit).
 */

import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Org-scoped tables filtered directly by `org_id` (organizations is by `id`; pruning_logs by session). */
const ORG_SCOPED_TABLES = [
  "developers",
  "org_config",
  "sessions",
  "billing_records",
  "invoices",
  "function_changes",
  "tech_decisions",
  "policy_updates",
  "todos",
  "variable_changes",
  "knowledge_entities",
  "knowledge_edges",
  "memory_vectors",
  "audit_conflicts",
  "api_keys",
] as const;

export interface BackupFile {
  orgId: string;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

interface Args {
  orgId?: string;
  out?: string;
  pretty: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--org-id":
        out.orgId = val();
        break;
      case "--out":
        out.out = val();
        break;
      case "--pretty":
        out.pretty = true;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Per-table row counts (pure; testable). */
export function summarizeBackup(b: BackupFile): { table: string; rows: number }[] {
  return Object.entries(b.tables).map(([table, rows]) => ({ table, rows: rows.length }));
}

/** Total rows across all tables (pure; testable). */
export function totalRows(b: BackupFile): number {
  return Object.values(b.tables).reduce((sum, rows) => sum + rows.length, 0);
}

/** A filesystem-safe timestamp slug for the default filename (pure; testable). */
export function backupFilename(orgId: string, isoTimestamp: string): string {
  const stamp = isoTimestamp.replace(/[:.]/g, "-");
  return `stratum-backup-${orgId.slice(0, 8)}-${stamp}.backup.json`;
}

async function selectAllByOrg(client: SupabaseClient, table: string, orgId: string): Promise<unknown[]> {
  const { data, error } = await client.from(table).select("*").eq("org_id", orgId);
  if (error) throw new Error(`export ${table} failed: ${error.message}`);
  return data ?? [];
}

/**
 * Export one org's full row-set across every org-scoped table.
 *
 * @param client - a service-role Supabase client.
 * @param orgId - the org to export.
 * @param exportedAt - ISO timestamp stamped into the file (injected for determinism).
 * @returns the {@link BackupFile}.
 * @throws {Error} if any table read fails (fail-loud — never write a partial backup silently).
 */
export async function exportOrg(client: SupabaseClient, orgId: string, exportedAt: string): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};

  const { data: orgRows, error: orgErr } = await client.from("organizations").select("*").eq("id", orgId);
  if (orgErr) throw new Error(`export organizations failed: ${orgErr.message}`);
  tables["organizations"] = orgRows ?? [];

  for (const t of ORG_SCOPED_TABLES) tables[t] = await selectAllByOrg(client, t, orgId);

  // pruning_logs has no org_id — scope it through the org's sessions.
  const sessionIds = (tables["sessions"] as { id: string }[]).map((r) => r.id);
  if (sessionIds.length > 0) {
    const { data, error } = await client.from("pruning_logs").select("*").in("session_id", sessionIds);
    if (error) throw new Error(`export pruning_logs failed: ${error.message}`);
    tables["pruning_logs"] = data ?? [];
  } else {
    tables["pruning_logs"] = [];
  }

  return { orgId, exportedAt, tables };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.orgId === undefined || args.orgId === "") {
    out("usage: npm run backup -- --org-id <uuid> [--out <path>] [--pretty]");
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("backup SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY to export. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  const backup = await exportOrg(client, args.orgId, new Date().toISOString());
  if ((backup.tables["organizations"] ?? []).length === 0) {
    out(`No organization found with id ${args.orgId} — nothing exported.`);
    return 1;
  }

  const dir = join(process.cwd(), "backups");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = args.out ?? join(dir, backupFilename(args.orgId, backup.exportedAt));
  writeFileSync(path, JSON.stringify(backup, null, args.pretty ? 2 : 0), "utf8");

  out(`Org backup — ${args.orgId}`);
  out("=".repeat(50));
  for (const { table, rows } of summarizeBackup(backup)) {
    if (rows > 0) out(`  ${table.padEnd(22)} ${rows}`);
  }
  out("-".repeat(50));
  out(`${totalRows(backup)} row(s) across ${Object.keys(backup.tables).length} tables → ${path}`);
  out("(restore is the documented follow-up; this export is read-only + safe.)");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("backup-org.ts") || entryPath.endsWith("backup-org.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`backup failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
