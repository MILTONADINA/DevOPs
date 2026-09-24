// Disposable local backup -> deletion -> restore across fact and audit tables.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (url !== "http://127.0.0.1:54321" || !key || process.env.DEVOPS_STRATUM_PROJECT_ROOT !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const session = randomUUID();
const sharedSession = randomUUID();
const fact = randomUUID();
const activeFact = randomUUID();
const conflict = randomUUID();
const entityA = randomUUID();
const entityB = randomUUID();
const fileEntity = randomUUID();
const edge = randomUUID();
const filePath = `src/local-recovery-${org}.ts`;
const backupPath = join(process.cwd(), "backups", `local-check-${org}.backup.json`);
const incompleteBackupPath = join(process.cwd(), "backups", `local-check-${org}-incomplete.backup.json`);
const foreignBackupPath = join(process.cwd(), "backups", `local-check-${org}-foreign.backup.json`);
const emptyLinkBackupPath = join(process.cwd(), "backups", `local-check-${org}-empty-links.backup.json`);
const overridePath = join(process.cwd(), "backups", `local-check-${org}.config.txt`);

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

function run(script, args) {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve(script), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_CONFIG_PATH: overridePath, DOTENV_CONFIG_OVERRIDE: "true" },
    encoding: "utf8", timeout: 30_000,
  });
  if (child.error || child.status !== 0) throw new Error(`${script} failed: ${child.error?.message ?? child.stderr ?? child.stdout}`);
}

async function clearRows() {
  for (const [table, column, value] of [
    ["audit_statuses", "fact_id", fact], ["audit_conflicts", "id", conflict],
    ["function_changes", "id", fact], ["function_changes", "id", activeFact],
    ["knowledge_edges", "id", edge],
    ["knowledge_entities", "id", entityA], ["knowledge_entities", "id", entityB],
    ["knowledge_entities", "id", fileEntity],
    ["sessions", "id", sharedSession], ["sessions", "id", session], ["organizations", "id", org],
  ]) checked(await db.from(table).delete().eq(column, value), `delete ${table}`);
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs local recovery check" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check" }), "insert session");
  checked(await db.from("sessions").insert({ id: sharedSession, org_id: org, model: "local-check" }), "insert shared session");
  checked(await db.from("knowledge_entities").insert([
    { id: entityA, org_id: org, session_id: session, kind: "Decision", name: `recovery-a-${org}`, provenance_complete: true, scope_verified: true },
    { id: entityB, org_id: org, session_id: session, kind: "Decision", name: `recovery-b-${org}`, provenance_complete: true, scope_verified: true },
  ]), "insert graph entities");
  checked(await db.from("knowledge_entities").insert({
    id: fileEntity, org_id: org, session_id: session, kind: "File",
    name: filePath, file_path: filePath, provenance_complete: true, scope_verified: true,
  }), "insert File entity");
  checked(await db.from("knowledge_edges").insert({
    id: edge, org_id: org, session_id: session, from_entity: entityA,
    to_entity: entityB, edge_type: "SUPERSEDES", provenance_complete: true, scope_verified: true,
  }), "insert graph edge");
  checked(await db.from("knowledge_entity_sessions").insert({ org_id: org, entity_id: entityA, session_id: sharedSession }), "link shared entity");
  checked(await db.from("knowledge_edge_sessions").insert({ org_id: org, edge_id: edge, session_id: sharedSession }), "link shared edge");
  checked(await db.from("function_changes").insert({
    id: fact, org_id: org, session_id: session, confidence: 0.9,
    old_name: "oldRecovery", new_name: "newRecovery", change_type: "renamed",
  }), "insert fact");
  const inserted = checked(await db.rpc("persist_audit_results", {
    p_org_id: org, p_session_id: session,
    p_rows: [{ id: conflict, fact_table: "function_changes", fact_id: fact,
      status: "CONFLICT", claimed_state: "oldRecovery renamed", actual_state: "newRecovery deleted", conflict_commit: "local-check" }],
  }), "persist conflict");
  if (inserted !== 1) throw new Error("expected one conflict before backup");
  checked(await db.from("function_changes").insert({
    id: activeFact, org_id: org, session_id: session, confidence: 0.9,
    old_name: "linkedRecovery", new_name: "linkedRecoveryNew", change_type: "renamed", file_path: filePath,
  }), "insert active linked fact");
  const originalSourceLink = checked(await db.from("source_fact_links").select("id,created_at").eq("org_id", org).eq("file_entity_id", fileEntity).eq("function_change_id", activeFact).single(), "read original source link");

  // If either CLI loads dotenv, this harmless project-local override points it
  // at a closed port and makes the check fail. Process credentials must win.
  mkdirSync(join(process.cwd(), "backups"), { recursive: true });
  writeFileSync(overridePath, "SUPABASE_URL=http://127.0.0.1:1\n");
  run("scripts/backup-org.ts", ["--org-id", org, "--out", backupPath]);
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  if (backup.orgId !== org || backup.tables.organizations.length !== 1 ||
      backup.tables.sessions.length !== 2 || backup.tables.function_changes.length !== 2 ||
      backup.tables.knowledge_entities.length !== 3 || backup.tables.knowledge_edges.length !== 1 ||
      backup.tables.knowledge_entity_sessions.length !== 4 || backup.tables.knowledge_edge_sessions.length !== 2 ||
      backup.tables.source_fact_links.length !== 1 || backup.tables.source_fact_links[0].id !== originalSourceLink.id ||
      backup.tables.source_fact_links[0].created_at !== originalSourceLink.created_at ||
      backup.tables.audit_statuses.length !== 1 || backup.tables.audit_conflicts.length !== 1) {
    throw new Error(`backup omitted an expected scoped row: ${JSON.stringify(Object.fromEntries(Object.entries(backup.tables).map(([name, rows]) => [name, rows.length])))}`);
  }

  const { audit_statuses: omitted, ...incompleteTables } = backup.tables;
  writeFileSync(incompleteBackupPath, JSON.stringify({ ...backup, tables: incompleteTables }));
  const invalidRestore = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/restore-org.ts"), "--file", incompleteBackupPath], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000,
  });
  if (invalidRestore.error || invalidRestore.status !== 1 || !invalidRestore.stdout.includes("backup table audit_statuses missing")) {
    throw new Error(`incomplete backup was not rejected before restore: ${invalidRestore.error?.message ?? invalidRestore.stdout}`);
  }
  const stillPresent = checked(await db.from("organizations").select("id").eq("id", org).single(), "check incomplete restore made no write");
  if (stillPresent.id !== org || omitted.length !== 1) throw new Error("incomplete restore changed its source organization");
  writeFileSync(foreignBackupPath, JSON.stringify({ ...backup, tables: {
    ...backup.tables, audit_statuses: backup.tables.audit_statuses.map((row) => ({ ...row, org_id: randomUUID() })),
  } }));
  const foreignRestore = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/restore-org.ts"), "--file", foreignBackupPath], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000,
  });
  if (foreignRestore.error || foreignRestore.status !== 1 || !foreignRestore.stdout.includes("backup table audit_statuses organization mismatch")) {
    throw new Error(`foreign organization backup was not rejected before restore: ${foreignRestore.error?.message ?? foreignRestore.stdout}`);
  }

  await clearRows();
  const missing = checked(await db.from("organizations").select("id").eq("id", org), "check deleted org");
  if (missing.length !== 0) throw new Error("source organization remains before restore");
  run("scripts/restore-org.ts", ["--file", backupPath]);

  const restoredFact = checked(await db.from("function_changes").select("id,is_suppressed,session_id").eq("id", fact).single(), "read restored fact");
  const restoredStatus = checked(await db.from("audit_statuses").select("status").eq("fact_id", fact).eq("org_id", org).single(), "read restored status");
  const restoredAlert = checked(await db.from("audit_conflicts").select("id,conflict_commit,acknowledged").eq("id", conflict).eq("org_id", org).single(), "read restored alert");
  const restoredShared = checked(await db.from("knowledge_entity_sessions").select("session_id").eq("org_id", org).eq("entity_id", entityA), "read restored entity links");
  const restoredEdgeLinks = checked(await db.from("knowledge_edge_sessions").select("session_id").eq("org_id", org).eq("edge_id", edge), "read restored edge links");
  const restoredSourceLink = checked(await db.from("source_fact_links").select("id,created_at").eq("org_id", org).eq("file_entity_id", fileEntity).eq("function_change_id", activeFact).single(), "read restored source link");
  const inventory = checked(await db.rpc("inspect_session_erasure", { p_org_id: org, p_session_id: session }), "read restored erasure inventory");
  if (restoredFact.id !== fact || restoredFact.session_id !== session || !restoredFact.is_suppressed ||
      restoredStatus.status !== "CONFLICT" || restoredAlert.id !== conflict ||
      restoredAlert.conflict_commit !== "local-check" || restoredAlert.acknowledged ||
      restoredShared.length !== 2 || restoredEdgeLinks.length !== 2 || inventory.graph_ownership !== "shared" ||
      restoredSourceLink.id !== originalSourceLink.id || restoredSourceLink.created_at !== originalSourceLink.created_at ||
      inventory.counts.source_fact_links !== 1) {
    throw new Error("restored fact or audit evidence differs from the backup");
  }
  writeFileSync(emptyLinkBackupPath, JSON.stringify({ ...backup, tables: { ...backup.tables, source_fact_links: [] } }));
  await clearRows();
  run("scripts/restore-org.ts", ["--file", emptyLinkBackupPath]);
  const emptyLinks = checked(await db.from("source_fact_links").select("id").eq("org_id", org), "read empty restored source links");
  if (emptyLinks.length !== 0) throw new Error("restore recreated source links absent from an explicit empty snapshot");
  process.stdout.write("local audited organization, graph provenance, and source-link backup and restore passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await clearRows(); } catch (error) { if (!failure) failure = error; }
  for (const path of [backupPath, incompleteBackupPath, foreignBackupPath, emptyLinkBackupPath, overridePath]) if (existsSync(path)) rmSync(path);
}
if (failure) throw failure;
