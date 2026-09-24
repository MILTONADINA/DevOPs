import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { hashApiKey, resolveApiKeyVia } from "../../src/proxy/auth";
import { createSupabaseConversationResolver } from "../../src/proxy/conversation";

const url = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !serviceKey || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through db:with-env against the project-local stack");
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const orgId = randomUUID();
const keyId = randomUUID();
const conversationId = randomUUID();
const exchangeId = randomUUID();
const newerDecisionId = "00000000-0000-4000-8000-000000000101";
const olderDecisionId = "00000000-0000-4000-8000-000000000102";
const rawKey = `cq_test_${randomUUID()}`;
const backupDir = join(process.cwd(), "backups");
const backupPath = join(backupDir, `conversation-check-${orgId}.backup.json`);
const invalidBackupPath = join(backupDir, `conversation-check-${orgId}-invalid.backup.json`);
let failure: unknown;

function checked(error: { message: string } | null, step: string): void {
  if (error) throw new Error(`${step}: ${error.message}`);
}
function runCli(script: string, args: string[]): void {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts", script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error || child.status !== 0) throw new Error(`${script} failed: ${child.error?.message ?? child.stderr ?? child.stdout}`);
}
async function clearFixture(): Promise<void> {
  checked((await db.from("tech_decisions").delete().eq("org_id", orgId)).error, "delete decisions");
  checked((await db.from("sessions").delete().eq("org_id", orgId)).error, "delete sessions");
  checked((await db.from("api_keys").delete().eq("org_id", orgId)).error, "delete keys");
  checked((await db.from("organizations").delete().eq("id", orgId)).error, "delete organization");
}

try {
  checked((await db.from("organizations").insert({ id: orgId, name: "conversation recovery fixture" })).error, "insert org");
  checked((await db.from("api_keys").insert({ id: keyId, org_id: orgId, project_scope: "orion", key_hash: hashApiKey(rawKey), name: "fixture" })).error, "insert key");
  checked(
    (await db.from("sessions").insert({ id: conversationId, org_id: orgId, conversation_key_id: keyId, project_scope: "orion", kind: "conversation", model: "local/check" })).error,
    "insert conversation",
  );
  checked(
    (
      await db
        .from("tech_decisions")
        .insert({
          id: olderDecisionId,
          org_id: orgId,
          session_id: conversationId,
          project_scope: "orion",
          source_exchange_id: exchangeId,
          created_at: "2026-09-20T00:00:00Z",
          decision_text: "Use old signing",
          domain: "auth",
          confidence: 0.9,
        })
    ).error,
    "insert older decision",
  );
  checked(
    (
      await db.from("tech_decisions").insert({
        id: newerDecisionId,
        org_id: orgId,
        session_id: conversationId,
        project_scope: "orion",
        source_exchange_id: exchangeId,
        created_at: "2026-09-21T00:00:00Z",
        decision_text: "Use new signing",
        domain: "auth",
        confidence: 0.9,
      })
    ).error,
    "insert newer decision",
  );
  checked((await db.rpc("review_tech_decision_supersession", {
    match_org: orgId, match_project_scope: "orion", newer_id: newerDecisionId, older_id: olderDecisionId,
    reviewer: "local-operator", evidence: "The newer signing decision replaces the older signing decision.",
  })).error, "review decision replacement");
  mkdirSync(backupDir, { recursive: true });
  runCli("backup-org.ts", ["--org-id", orgId, "--out", backupPath]);
  const invalidBackup = JSON.parse(readFileSync(backupPath, "utf8")) as { tables: { tech_decisions: Array<Record<string, unknown>> } };
  invalidBackup.tables.tech_decisions[0]!.supersedes_id = randomUUID();
  writeFileSync(invalidBackupPath, JSON.stringify(invalidBackup));
  const rejected = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/restore-org.ts"), "--file", invalidBackupPath], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (rejected.error || rejected.status !== 1 || !rejected.stdout.includes("supersedes reference missing")) {
    throw new Error("missing supersession reference was not rejected before restore");
  }
  const untouched = await db.from("tech_decisions").select("id").eq("org_id", orgId);
  checked(untouched.error, "read untouched decisions");
  if (untouched.data?.length !== 2) throw new Error("invalid restore changed source organization");
  await clearFixture();
  runCli("restore-org.ts", ["--file", backupPath]);
  const auth = await resolveApiKeyVia(db)(rawKey);
  if (!auth || auth.orgId !== orgId || auth.keyId !== keyId || auth.projectScopeId !== `${orgId}/orion`) throw new Error("restored key binding differs");
  const continued = await createSupabaseConversationResolver(db)({ orgId: auth.orgId, keyId: auth.keyId, projectScopeId: auth.projectScopeId, model: "local/check", requestedId: conversationId });
  if (continued !== conversationId) throw new Error("restored conversation cannot continue");
  const decisions = await db.from("tech_decisions").select("id,session_id,supersedes_id,source_exchange_id,supersession_reviewer,supersession_evidence,supersession_reviewed_at").eq("org_id", orgId).order("id");
  checked(decisions.error, "read restored decisions");
  if (
    decisions.data?.length !== 2 ||
    decisions.data[0]?.id !== newerDecisionId ||
    decisions.data[0]?.session_id !== conversationId ||
    decisions.data[0]?.source_exchange_id !== exchangeId ||
    decisions.data[0]?.supersedes_id !== olderDecisionId ||
    decisions.data[0]?.supersession_reviewer !== "local-operator" ||
    decisions.data[0]?.supersession_evidence !== "The newer signing decision replaces the older signing decision." ||
    !decisions.data[0]?.supersession_reviewed_at ||
    decisions.data[1]?.id !== olderDecisionId ||
    decisions.data[1]?.source_exchange_id !== exchangeId ||
    decisions.data[1]?.supersedes_id !== null
  ) {
    throw new Error("restored decision supersession differs from backup");
  }
  process.stdout.write("local conversation and decision supersession backup/restore passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await clearFixture();
  } catch (error) {
    if (!failure) failure = error;
  }
  if (existsSync(backupPath)) rmSync(backupPath);
  if (existsSync(invalidBackupPath)) rmSync(invalidBackupPath);
}
if (failure) throw failure;
