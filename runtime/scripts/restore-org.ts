/**
 * Org restore — re-insert a `npm run backup` JSON export (v0.8.x: "backup tested", write half).
 *
 * The complement to backup-org.ts: read a backup file and re-insert its rows into Supabase in
 * FK-dependency order, preserving UUIDs so every cross-table reference stays valid. Intended for
 * disaster recovery into a CLEAN target (or after the org was deleted) — a plain insert that
 * FAILS LOUD on any error (a PK collision means the org still exists; restore into an empty DB).
 *
 *   npm run restore -- --file <path> [--dry-run] [--keep-key-state]
 *
 * billing_records has GENERATED columns (token_delta/cost_delta_usd); those are stripped before
 * insert so the DB recomputes them. Pre-C2 backups' retired fee/signature columns are stripped
 * and reported as well. C4's retired invoice tables are validated, reported and skipped.
 * Decision supersession references are restored after all decisions exist.
 * Before active inserts, database admission rejects known erased identities and records
 * unknown coverage for the imported organization. This is not an atomic bulk restore.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ORG_SCOPED_TABLES, type BackupFile } from "./backup-org";
import { TABLE_FACT_TYPES, rowToFact } from "../src/memory/warm/tier2";

/** Insert order: every parent table before its children (FK-safe). */
export const RESTORE_ORDER = [
  "organizations",
  "developers",
  "org_config",
  "api_keys",
  "sessions",
  "function_changes",
  "tech_decisions",
  "policy_updates",
  "todos",
  "variable_changes",
  "operational_references",
  "pruning_logs",
  "billing_records",
  "knowledge_entities",
  "knowledge_edges",
  "knowledge_entity_sessions",
  "knowledge_edge_sessions",
  "source_fact_links",
  "memory_vectors",
  "audit_conflicts",
  "audit_statuses",
] as const;

/** Columns the DB GENERATEs — must NOT be sent on insert (it recomputes them). */
const GENERATED_COLS: Record<string, string[]> = {
  billing_records: ["token_delta", "cost_delta_usd"],
};

/** M1 removed these columns; old backups remain valid input. */
const RETIRED_COLS: Record<string, string[]> = {
  billing_records: ["cq_fee_usd", "signed_hash"],
};

/** M2 removed these tables; only scoped legacy row arrays are accepted and skipped. */
const RETIRED_TABLES = new Set(["invoices", "invoice_send_claims"]);

interface Args {
  file?: string;
  dryRun: boolean;
  /** Restore each API key's backed-up `is_active` instead of restoring every key inactive (PB-64). */
  keepKeyState: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, keepKeyState: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok === "--file") out.file = argv[++i] ?? "";
    else if (tok === "--dry-run") out.dryRun = true;
    else if (tok === "--keep-key-state") out.keepKeyState = true;
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
  if (!Array.isArray(b.tables["operational_references"])) {
    throw new Error("backup predates operational_references; restore requires a complete current-schema export");
  }
  for (const table of expected) {
    if (!Array.isArray(b.tables[table])) throw new Error(`backup table ${table} missing or not an array`);
  }
  for (const table of Object.keys(b.tables)) {
    if (!expected.has(table) && !RETIRED_TABLES.has(table)) throw new Error(`backup table ${table} is not supported by restore`);
  }
  for (const table of RETIRED_TABLES) {
    if (!Object.hasOwn(b.tables, table)) continue;
    const rows = b.tables[table];
    if (!Array.isArray(rows)) throw new Error(`backup table ${table} must be an array`);
    if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
      throw new Error(`backup table ${table} row must be an object`);
    }
    if (rows.some((row) => (row as { org_id?: unknown }).org_id !== b.orgId)) {
      throw new Error(`backup table ${table} organization mismatch`);
    }
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
  const decisions = b.tables["tech_decisions"] ?? [];
  const decisionById = new Map<string, Record<string, unknown>>();
  for (const row of decisions) {
    const decision = row as Record<string, unknown> | null;
    const id = decision?.["id"];
    if (typeof id !== "string" || id === "") throw new Error("backup decision ID missing");
    if (decisionById.has(id)) throw new Error("backup duplicate decision ID");
    decisionById.set(id, decision!);
  }
  const supersededIds = new Set<string>();
  for (const row of decisions) {
    const decision = row as {
      supersedes_id?: unknown;
      supersession_reviewer?: unknown;
      supersession_evidence?: unknown;
      supersession_reviewed_at?: unknown;
    } | null;
    const reference = decision?.supersedes_id;
    if (reference == null) {
      if (decision?.supersession_reviewer != null || decision?.supersession_evidence != null || decision?.supersession_reviewed_at != null) {
        throw new Error("backup review metadata without supersedes reference");
      }
      continue;
    }
    if (typeof reference !== "string" || reference === "") throw new Error("backup supersedes reference invalid");
    const older = decisionById.get(reference);
    if (!older) throw new Error("backup supersedes reference missing from decisions");
    if (supersededIds.has(reference)) throw new Error("backup duplicate successor for superseded decision");
    supersededIds.add(reference);
    const newer = row as Record<string, unknown>;
    if (newer["project_scope"] !== older["project_scope"]) throw new Error("backup supersedes project mismatch");
    const newerTime = Date.parse(String(newer["created_at"]));
    const olderTime = Date.parse(String(older["created_at"]));
    if (!Number.isFinite(newerTime) || !Number.isFinite(olderTime) || newerTime <= olderTime ||
        newer["is_suppressed"] === true || older["is_suppressed"] === true) {
      throw new Error("backup supersedes reference requires active newer decision");
    }
    if (
      typeof decision?.supersession_reviewer !== "string" || decision.supersession_reviewer.trim().length < 3 ||
      typeof decision.supersession_evidence !== "string" || decision.supersession_evidence.trim().length < 20 ||
      typeof decision.supersession_reviewed_at !== "string" || !Number.isFinite(Date.parse(decision.supersession_reviewed_at))
    ) {
      throw new Error("backup supersession review evidence, reviewer, or time invalid");
    }
  }
  const sessionIds = new Set<string>();
  const keyIds = new Set((b.tables["api_keys"] ?? []).map((row) => (row as { id?: unknown } | null)?.id));
  for (const row of b.tables["sessions"] ?? []) {
    const session = row as { id?: unknown; kind?: unknown; conversation_key_id?: unknown } | null;
    const id = session?.id;
    if (typeof id !== "string" || id === "") throw new Error("backup session ID missing");
    if (session?.kind === "conversation" && (typeof session.conversation_key_id !== "string" || !keyIds.has(session.conversation_key_id))) {
      throw new Error("backup conversation key missing from organization");
    }
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
  // v0.5 gate "Zod validation gates all writes": restore writes facts, so every fact row must pass the same
  // schema the reader applies (rowToFact -> validateFact). Suppression is a state, not content, so a suppressed
  // row is validated as if it were active.
  for (const table of Object.keys(TABLE_FACT_TYPES)) {
    for (const row of b.tables[table] ?? []) {
      const r = row as Record<string, unknown> | null;
      if (!r || rowToFact(table, { ...r, is_suppressed: false }) === null) {
        throw new Error(`backup table ${table} row ${String(r?.["id"] ?? "?")} fails fact validation`);
      }
    }
  }
  return b as BackupFile;
}

/** Strip GENERATED and retired columns before insert (pure; returns new row objects). */
export function stripGeneratedCols(table: string, rows: unknown[]): unknown[] {
  const drop = [...(GENERATED_COLS[table] ?? []), ...(RETIRED_COLS[table] ?? [])];
  if (drop.length === 0) return rows;
  return rows.map((r) => {
    const copy = { ...(r as Record<string, unknown>) };
    for (const c of drop) delete copy[c];
    return copy;
  });
}

/**
 * The ordered, non-empty insert plan (pure; testable). Tables absent/empty in the backup are skipped.
 * API keys are restored inactive unless `keepKeyState` is set: a backup cannot know about revocations
 * made after it was taken, so reactivating a leaked, since-revoked key must be an explicit choice (PB-64).
 */
export function restorePlan(backup: BackupFile, { keepKeyState = false }: { keepKeyState?: boolean } = {}): { table: string; rows: unknown[] }[] {
  const plan: { table: string; rows: unknown[] }[] = [];
  const hasDecisionReferences = decisionSupersessionUpdates(backup).length > 0;
  for (const table of RESTORE_ORDER) {
    const rows = backup.tables[table];
    if (Array.isArray(rows) && rows.length > 0)
      plan.push({
        table,
        rows: table === "tech_decisions" && hasDecisionReferences
          ? rows.map((row) => {
            const decision = row as Record<string, unknown>;
            return decision["supersedes_id"]
              ? { ...decision, supersedes_id: null, supersession_reviewer: null, supersession_evidence: null, supersession_reviewed_at: null }
              : decision;
          })
          : table === "api_keys" && !keepKeyState
            ? stripGeneratedCols(table, rows).map((row) => ({ ...(row as Record<string, unknown>), is_active: false }))
            : stripGeneratedCols(table, rows),
      });
  }
  return plan;
}

interface ReviewedSupersession {
  id: string;
  supersedes_id: string;
  supersession_reviewer: string;
  supersession_evidence: string;
  supersession_reviewed_at: string;
}

/** References patched after every decision ID has been inserted. */
export function decisionSupersessionUpdates(backup: BackupFile): ReviewedSupersession[] {
  return (backup.tables["tech_decisions"] ?? []).flatMap((row) => {
    const decision = row as ReviewedSupersession & { supersedes_id?: string | null };
    return decision.supersedes_id ? [{
      id: decision.id,
      supersedes_id: decision.supersedes_id,
      supersession_reviewer: decision.supersession_reviewer,
      supersession_evidence: decision.supersession_evidence,
      supersession_reviewed_at: decision.supersession_reviewed_at,
    }] : [];
  });
}

/** PostgreSQL accepts braces, case variants and hyphens after any four hex digits. */
function canonicalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const inner = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(inner)) return null;
  const hex = inner.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pointer-only admission inputs; never transmit backed-up content to the authority RPC. */
export function restoreErasureIdentities(backup: BackupFile): { p_org_id: string; p_session_ids: string[]; p_fact_ids: string[]; p_entity_ids: string[] } {
  const sessions = new Set<string>();
  const facts = new Set<string>();
  const entities = new Set<string>();
  const add = (set: Set<string>, value: unknown): void => {
    if (value == null) return;
    if (typeof value !== "string" || value === "") throw new Error("restore identity invalid");
    // Real UUID columns are also checked by the RPC's UUID[] argument parser.
    set.add(canonicalUuid(value) ?? value);
  };
  for (const table of RESTORE_ORDER) {
    for (const value of backup.tables[table] ?? []) {
      const row = value as Record<string, unknown>;
      add(sessions, row["session_id"]);
      if (table === "sessions") add(sessions, row["id"]);
      if (Object.hasOwn(TABLE_FACT_TYPES, table)) add(facts, row["id"]);
      if (table === "tech_decisions") add(facts, row["supersedes_id"]);
      if (table === "audit_conflicts" || table === "audit_statuses") add(facts, row["fact_id"]);
      if (table === "knowledge_entities") add(entities, row["id"]);
      if (table === "knowledge_edges") {
        add(entities, row["from_entity"]);
        add(entities, row["to_entity"]);
      }
      if (table === "knowledge_entity_sessions") add(entities, row["entity_id"]);
      if (table === "source_fact_links") {
        add(entities, row["file_entity_id"]);
        add(facts, row["function_change_id"]);
        add(facts, row["tech_decision_id"]);
      }
      if (table === "memory_vectors") {
        const reference = canonicalUuid(row["source_ref"]);
        // Unrelated non-UUID legacy pointers remain unknown. A UUID turn pointer
        // must not evade known tombstones by relabeling a retired fact/entity.
        if (reference && (row["source_type"] === "fact" || row["source_type"] === "turn")) facts.add(reference);
        if (reference && (row["source_type"] === "entity" || row["source_type"] === "turn")) entities.add(reference);
      }
    }
  }
  return { p_org_id: canonicalUuid(backup.orgId) ?? backup.orgId, p_session_ids: [...sessions].sort(), p_fact_ids: [...facts].sort(), p_entity_ids: [...entities].sort() };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.file === undefined || args.file === "") {
    out("usage: npm run restore -- --file <path> [--dry-run] [--keep-key-state]");
    return 1;
  }

  let backup: BackupFile;
  try {
    backup = validateBackup(JSON.parse(readFileSync(args.file, "utf8")) as unknown);
  } catch (e) {
    out(`invalid backup file: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const plan = restorePlan(backup, { keepKeyState: args.keepKeyState });
  for (const table of RETIRED_TABLES) {
    const rows = backup.tables[table];
    if (Array.isArray(rows)) out(`Note: skipped retired table ${table} (${rows.length} row(s)).`);
  }
  for (const [table, columns] of Object.entries(RETIRED_COLS)) {
    for (const column of columns) {
      const count = (backup.tables[table] ?? []).filter((row) => Object.hasOwn(row as object, column)).length;
      if (count > 0) out(`Note: stripped retired column ${table}.${column} from ${count} row(s) in the restore plan.`);
    }
  }
  const keyCount = (backup.tables["api_keys"] ?? []).length;
  if (keyCount > 0 && !args.keepKeyState) {
    out(`Note: ${keyCount} API key(s) will be restored INACTIVE. A backup cannot know about revocations made after it was taken; mint new keys with npm run create-api-key, or re-run with --keep-key-state to restore each key's backed-up state.`);
  }
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
  try {
    const admission = await client.rpc("prepare_erasure_restore", restoreErasureIdentities(backup));
    if (admission?.data !== true || admission.error !== null) throw new Error("unacknowledged restore admission");
  } catch {
    throw new Error("restore erasure admission failed; no rows inserted");
  }

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
    if (table === "tech_decisions") {
      for (const reference of decisionSupersessionUpdates(backup)) {
        const restored = await client.from("tech_decisions").update({
          supersedes_id: reference.supersedes_id,
          supersession_reviewer: reference.supersession_reviewer,
          supersession_evidence: reference.supersession_evidence,
          supersession_reviewed_at: reference.supersession_reviewed_at,
        }).eq("org_id", backup.orgId).eq("id", reference.id).select("id");
        if (restored.error || restored.data?.length !== 1) throw new Error(`restore decision supersession failed: ${restored.error?.message ?? "decision missing"}`);
      }
    }
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
