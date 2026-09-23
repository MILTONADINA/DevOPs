// Real Git index -> deterministic audit -> local Supabase RPC, with disposable data.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
const scratch = mkdtempSync(join(root, ".workflow/state/local-audit-git-"));
const gitConfig = join(scratch, "gitconfig");
writeFileSync(gitConfig, "");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
const org = randomUUID();
const session = randomUUID();
const fact = randomUUID();
const suffix = fact.slice(0, 8);
const oldName = `oldAudit${suffix}`;
const newName = `newAudit${suffix}`;

function run(command, args, cwd, env = gitEnv) {
  const child = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${child.error?.message ?? child.stderr}`);
  return child.stdout.trim();
}

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let failure;
try {
  run("git", ["init", "-q"], scratch);
  const commit = (source, message, date) => {
    writeFileSync(join(scratch, "module.js"), source);
    run("git", ["add", "module.js"], scratch);
    run("git", ["-c", "user.name=DevOPs Check", "-c", "user.email=check@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], scratch, {
      ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    });
    return run("git", ["rev-parse", "HEAD"], scratch);
  };
  commit(`export function ${oldName}() { return 1; }\n`, "add old function", "2026-09-22T10:00:00+00:00");
  const renameCommit = commit(`export function ${newName}() { return 1; }\n`, "rename function", "2026-09-22T10:01:00+00:00");
  const deletionCommit = commit("export const marker = 1;\n", "delete new function", "2026-09-22T10:02:00+00:00");

  checked(await db.from("organizations").insert({ id: org, name: "DevOPs local Git audit check" }), "insert org");
  checked(await db.from("sessions").insert({ id: session, org_id: org, model: "local-check" }), "insert session");
  checked(await db.from("function_changes").insert({
    id: fact, org_id: org, session_id: session, commit_hash: renameCommit,
    confidence: 0.9, old_name: oldName, new_name: newName, change_type: "renamed",
  }), "insert fact");
  const factsPath = join(scratch, "facts.json");
  writeFileSync(factsPath, JSON.stringify([{
    id: fact, created_at: new Date().toISOString(), session_id: session,
    commit_hash: renameCommit, confidence: 0.9, is_verified: false,
    is_suppressed: false, fact_type: "FunctionChange", old_name: oldName,
    new_name: newName, change_type: "renamed",
  }]));

  const audit = spawnSync(resolve("node_modules/.bin/tsx"), [
    resolve("scripts/audit-repo.ts"), "--max-count", "3", "--facts", factsPath,
    "--persist", "--org-id", org, "--session-id", session,
  ], { cwd: scratch, env: gitEnv, encoding: "utf8", timeout: 30_000 });
  if (audit.error || audit.status !== 1 || !audit.stdout.includes("Summary: 0 CONFIRMED, 0 UNVERIFIED, 1 CONFLICT") ||
      !audit.stdout.includes("Persisted 1 audit outcome(s), including 1 new CONFLICT alert(s).") ||
      !audit.stdout.includes(deletionCommit)) {
    throw new Error(`Git audit did not persist the expected conflict: ${audit.error?.message ?? audit.stderr ?? audit.stdout}`);
  }

  const row = checked(await db.from("function_changes").select("is_suppressed").eq("id", fact).eq("org_id", org).single(), "read fact");
  const status = checked(await db.from("audit_statuses").select("status").eq("fact_id", fact).eq("org_id", org).single(), "read status");
  const alerts = checked(await db.from("audit_conflicts").select("fact_id,conflict_commit,acknowledged").eq("fact_id", fact).eq("org_id", org), "read alert");
  if (!row.is_suppressed || status.status !== "CONFLICT" || alerts.length !== 1 || alerts[0].acknowledged || alerts[0].conflict_commit !== deletionCommit) {
    throw new Error("local database did not retain the expected suppression, status, and alert");
  }
  process.stdout.write("real Git audit persisted local suppression, status, and alert\n");
} catch (error) {
  failure = error;
} finally {
  for (const [table, column, value] of [
    ["audit_statuses", "fact_id", fact], ["audit_conflicts", "fact_id", fact],
    ["function_changes", "id", fact], ["sessions", "id", session], ["organizations", "id", org],
  ]) {
    try {
      const result = await db.from(table).delete().eq(column, value);
      if (result.error && !failure) failure = new Error(`cleanup ${table}: ${result.error.message}`);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  try {
    const remaining = await db.from("organizations").select("id").eq("id", org);
    if (remaining.error || (remaining.data ?? []).length !== 0) {
      if (!failure) failure = new Error(`cleanup verification failed: ${remaining.error?.message ?? "organization remains"}`);
    }
  } catch (error) {
    if (!failure) failure = error;
  }
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) throw failure;
