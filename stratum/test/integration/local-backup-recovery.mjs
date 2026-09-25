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
const referenceFact = randomUUID();
const referenceSession = randomUUID();
const referenceKey = randomUUID();
const referenceExchange = randomUUID();
const referenceCreatedAt = "2026-09-23T12:34:56Z";
const oldDecision = randomUUID();
const newDecision = randomUUID();
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
    ["audit_statuses", "fact_id", fact], ["audit_statuses", "fact_id", referenceFact], ["audit_conflicts", "id", conflict],
    ["function_changes", "id", fact], ["operational_references", "id", referenceFact], ["function_changes", "id", activeFact],
    ["tech_decisions", "id", newDecision], ["tech_decisions", "id", oldDecision],
    ["knowledge_edges", "id", edge],
    ["knowledge_entities", "id", entityA], ["knowledge_entities", "id", entityB],
    ["knowledge_entities", "id", fileEntity],
    ["sessions", "id", referenceSession], ["sessions", "id", sharedSession], ["sessions", "id", session], ["api_keys", "id", referenceKey],
    ["invoice_send_claims", "org_id", org], ["organizations", "id", org],
  ]) checked(await db.from(table).delete().eq(column, value), `delete ${table}`);
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs local recovery check" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check" }), "insert session");
  checked(await db.from("sessions").insert({ id: sharedSession, org_id: org, model: "local-check" }), "insert shared session");
  checked(await db.from("api_keys").insert({ id: referenceKey, org_id: org, key_hash: randomUUID(), name: "reference fixture", project_scope: "orion" }), "insert reference key");
  checked(await db.from("invoice_send_claims").insert({ org_id: org, period_start: "2026-08-01T00:00:00Z", period_end: "2026-09-01T00:00:00Z" }), "insert held invoice claim");
  checked(await db.from("sessions").insert({ id: referenceSession, org_id: org, project_scope: "orion", kind: "conversation", conversation_key_id: referenceKey, model: "local-check" }), "insert reference conversation");
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
  checked(await db.from("operational_references").insert({
    id: referenceFact, org_id: org, session_id: referenceSession, project_scope: "orion", source_exchange_id: referenceExchange, created_at: referenceCreatedAt, confidence: 0.92,
    subject: "recovery runbook", reference: "RUNBOOK_RECOVERY.md",
  }), "insert operational reference");
  checked(await db.rpc("persist_audit_results", {
    p_org_id: org, p_session_id: referenceSession,
    p_rows: [{ fact_table: "operational_references", fact_id: referenceFact, status: "UNVERIFIED" }],
  }), "persist reference audit");
  checked(await db.from("tech_decisions").insert([
    { id: oldDecision, org_id: org, session_id: session, created_at: "2026-09-20T00:00:00Z", confidence: 0.9, decision_text: "old runtime", domain: "runtime" },
    { id: newDecision, org_id: org, session_id: session, created_at: "2026-09-21T00:00:00Z", confidence: 0.9, decision_text: "new runtime", domain: "runtime" },
  ]), "insert review decisions");
  checked(await db.rpc("review_tech_decision_supersession", {
    match_org: org, match_project_scope: null, newer_id: newDecision, older_id: oldDecision,
    reviewer: "local-operator", evidence: "Local recovery fixture verifies the reviewed decision link.",
  }), "review decision supersession");
  const originalSourceLink = checked(await db.from("source_fact_links").select("id,created_at").eq("org_id", org).eq("file_entity_id", fileEntity).eq("function_change_id", activeFact).single(), "read original source link");

  // If either CLI loads dotenv, this harmless project-local override points it
  // at a closed port and makes the check fail. Process credentials must win.
  mkdirSync(join(process.cwd(), "backups"), { recursive: true });
  writeFileSync(overridePath, "SUPABASE_URL=http://127.0.0.1:1\n");
  run("scripts/backup-org.ts", ["--org-id", org, "--out", backupPath]);
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  if (backup.orgId !== org || backup.tables.organizations.length !== 1 ||
      backup.tables.sessions.length !== 3 || backup.tables.api_keys.length !== 1 || backup.tables.function_changes.length !== 2 ||
      backup.tables.tech_decisions.length !== 2 || backup.tables.operational_references.length !== 1 ||
      backup.tables.operational_references[0].id !== referenceFact ||
      backup.tables.operational_references[0].project_scope !== "orion" ||
      backup.tables.operational_references[0].source_exchange_id !== referenceExchange ||
      backup.tables.operational_references[0].created_at !== "2026-09-23T12:34:56+00:00" ||
      backup.tables.knowledge_entities.length !== 3 || backup.tables.knowledge_edges.length !== 1 ||
      backup.tables.knowledge_entity_sessions.length !== 4 || backup.tables.knowledge_edge_sessions.length !== 2 ||
      backup.tables.source_fact_links.length !== 1 || backup.tables.source_fact_links[0].id !== originalSourceLink.id ||
      backup.tables.source_fact_links[0].created_at !== originalSourceLink.created_at ||
      backup.tables.audit_statuses.length !== 2 || backup.tables.audit_conflicts.length !== 1) {
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
  if (stillPresent.id !== org || omitted.length !== 2) throw new Error("incomplete restore changed its source organization");
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
  const restoredReference = checked(await db.from("operational_references").select("id,session_id,project_scope,source_exchange_id,created_at,subject,reference").eq("id", referenceFact).single(), "read restored reference");
  const restoredDecision = checked(await db.from("tech_decisions").select("supersedes_id,supersession_reviewer,supersession_evidence,supersession_reviewed_at").eq("id", newDecision).single(), "read reviewed decision");
  const backedDecision = backup.tables.tech_decisions.find((row) => row.id === newDecision);
  const restoredStatus = checked(await db.from("audit_statuses").select("status").eq("fact_id", fact).eq("org_id", org).single(), "read restored status");
  const restoredReferenceStatus = checked(await db.from("audit_statuses").select("status").eq("fact_id", referenceFact).eq("org_id", org).single(), "read restored reference audit");
  const restoredAlert = checked(await db.from("audit_conflicts").select("id,conflict_commit,acknowledged").eq("id", conflict).eq("org_id", org).single(), "read restored alert");
  const restoredShared = checked(await db.from("knowledge_entity_sessions").select("session_id").eq("org_id", org).eq("entity_id", entityA), "read restored entity links");
  const restoredEdgeLinks = checked(await db.from("knowledge_edge_sessions").select("session_id").eq("org_id", org).eq("edge_id", edge), "read restored edge links");
  const restoredSourceLink = checked(await db.from("source_fact_links").select("id,created_at").eq("org_id", org).eq("file_entity_id", fileEntity).eq("function_change_id", activeFact).single(), "read restored source link");
  const restoredClaims = checked(await db.from("invoice_send_claims").select("period_start,period_end").eq("org_id", org), "read restored invoice claims");
  const restoredKey = checked(await db.from("api_keys").select("is_active").eq("id", referenceKey).single(), "read restored key state");
  if (restoredClaims.length !== 1 || restoredKey.is_active !== false) {
    throw new Error(`held invoice claim not restored (${restoredClaims.length}) or a restored key is active (${restoredKey.is_active}); PB-64/PB-65`);
  }
  const inventory = checked(await db.rpc("inspect_session_erasure", { p_org_id: org, p_session_id: session }), "read restored erasure inventory");
  const referenceInventory = checked(await db.rpc("inspect_session_erasure", { p_org_id: org, p_session_id: referenceSession }), "read restored reference inventory");
  if (restoredFact.id !== fact || restoredFact.session_id !== session || !restoredFact.is_suppressed ||
      restoredDecision.supersedes_id !== oldDecision || restoredDecision.supersession_reviewer !== backedDecision.supersession_reviewer ||
      restoredDecision.supersession_evidence !== backedDecision.supersession_evidence || restoredDecision.supersession_reviewed_at !== backedDecision.supersession_reviewed_at ||
      restoredStatus.status !== "CONFLICT" || restoredReferenceStatus.status !== "UNVERIFIED" ||
      restoredReference.id !== referenceFact || restoredReference.session_id !== referenceSession ||
      restoredReference.project_scope !== "orion" || restoredReference.source_exchange_id !== referenceExchange ||
      restoredReference.created_at !== backup.tables.operational_references[0].created_at ||
      restoredReference.reference !== "RUNBOOK_RECOVERY.md" || inventory.counts.operational_references !== 0 || referenceInventory.counts.operational_references !== 1 || restoredAlert.id !== conflict ||
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
