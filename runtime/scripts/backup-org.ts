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

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Org-scoped tables filtered directly by `org_id` (organizations is by `id`; pruning_logs by session). */
export const ORG_SCOPED_TABLES = [
  "developers",
  "org_config",
  "sessions",
  "billing_records",
  "invoices",
  "invoice_send_claims",
  "function_changes",
  "tech_decisions",
  "policy_updates",
  "todos",
  "variable_changes",
  "operational_references",
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

async function selectAll(client: SupabaseClient, table: string, column: string, value: string | string[], orderColumns: string[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  let expected: number | undefined;
  while (true) {
    const base = client.from(table).select("*", { count: "exact" });
    let query = Array.isArray(value) ? base.in(column, value) : base.eq(column, value);
    for (const order of orderColumns) query = query.order(order, { ascending: true });
    const { data, error, count } = await query.range(rows.length, rows.length + 499);
    if (error) throw new Error(`export ${table} failed: ${error.message}`);
    if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error(`export ${table} failed: exact row count unavailable`);
    if (expected !== undefined && count !== expected) throw new Error(`export ${table} failed: row count changed during paging`);
    expected = count;
    const page = data ?? [];
    if (page.length === 0 && rows.length < expected) throw new Error(`export ${table} failed: empty page before exact row count`);
    rows.push(...page);
    if (rows.length > expected) throw new Error(`export ${table} failed: page exceeded exact row count`);
    if (rows.length === expected) return rows;
  }
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

  tables["organizations"] = await selectAll(client, "organizations", "id", orgId, ["id"]);

  for (const t of ORG_SCOPED_TABLES) {
    const order =
      t === "org_config"
        ? ["org_id"]
        : t === "audit_statuses"
          ? ["fact_table", "fact_id"]
          : t === "knowledge_entity_sessions"
            ? ["entity_id", "session_id"]
            : t === "knowledge_edge_sessions"
              ? ["edge_id", "session_id"]
              : t === "invoice_send_claims"
                ? ["period_start", "period_end"] // primary key (org_id, period_start, period_end); no id column
                : ["id"];
    tables[t] = await selectAll(client, t, "org_id", orgId, order);
  }

  // pruning_logs has no org_id — scope it through the org's sessions.
  const sessionIds = (tables["sessions"] as { id: string }[]).map((r) => r.id);
  if (sessionIds.length > 0) {
    const logs: unknown[] = [];
    for (let i = 0; i < sessionIds.length; i += 100) {
      logs.push(...(await selectAll(client, "pruning_logs", "session_id", sessionIds.slice(i, i + 100), ["id"])));
    }
    tables["pruning_logs"] = logs;
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
    out("backup failed: set SUPABASE_URL + SUPABASE_SERVICE_KEY to export.");
    return 1;
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
