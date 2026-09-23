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
const fact = randomUUID();
const conflict = randomUUID();
const backupPath = join(process.cwd(), "backups", `local-check-${org}.backup.json`);
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
    ["function_changes", "id", fact], ["sessions", "id", session], ["organizations", "id", org],
  ]) checked(await db.from(table).delete().eq(column, value), `delete ${table}`);
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs local recovery check" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check" }), "insert session");
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

  // If either CLI loads dotenv, this harmless project-local override points it
  // at a closed port and makes the check fail. Process credentials must win.
  mkdirSync(join(process.cwd(), "backups"), { recursive: true });
  writeFileSync(overridePath, "SUPABASE_URL=http://127.0.0.1:1\n");
  run("scripts/backup-org.ts", ["--org-id", org, "--out", backupPath]);
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  if (backup.orgId !== org || backup.tables.organizations.length !== 1 ||
      backup.tables.sessions.length !== 1 || backup.tables.function_changes.length !== 1 ||
      backup.tables.audit_statuses.length !== 1 || backup.tables.audit_conflicts.length !== 1) {
    throw new Error("backup omitted an expected scoped row");
  }

  await clearRows();
  const missing = checked(await db.from("organizations").select("id").eq("id", org), "check deleted org");
  if (missing.length !== 0) throw new Error("source organization remains before restore");
  run("scripts/restore-org.ts", ["--file", backupPath]);

  const restoredFact = checked(await db.from("function_changes").select("id,is_suppressed,session_id").eq("id", fact).single(), "read restored fact");
  const restoredStatus = checked(await db.from("audit_statuses").select("status").eq("fact_id", fact).eq("org_id", org).single(), "read restored status");
  const restoredAlert = checked(await db.from("audit_conflicts").select("id,conflict_commit,acknowledged").eq("id", conflict).eq("org_id", org).single(), "read restored alert");
  if (restoredFact.id !== fact || restoredFact.session_id !== session || !restoredFact.is_suppressed ||
      restoredStatus.status !== "CONFLICT" || restoredAlert.id !== conflict ||
      restoredAlert.conflict_commit !== "local-check" || restoredAlert.acknowledged) {
    throw new Error("restored fact or audit evidence differs from the backup");
  }
  process.stdout.write("local audited organization backup and restore passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await clearRows(); } catch (error) { if (!failure) failure = error; }
  for (const path of [backupPath, overridePath]) if (existsSync(path)) rmSync(path);
}
if (failure) throw failure;
