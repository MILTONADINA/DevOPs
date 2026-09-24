import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
const rawKey = `cq_test_${randomUUID()}`;
const backupDir = join(process.cwd(), "backups");
const backupPath = join(backupDir, `conversation-check-${orgId}.backup.json`);
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
  mkdirSync(backupDir, { recursive: true });
  runCli("backup-org.ts", ["--org-id", orgId, "--out", backupPath]);
  await clearFixture();
  runCli("restore-org.ts", ["--file", backupPath]);
  const auth = await resolveApiKeyVia(db)(rawKey);
  if (!auth || auth.orgId !== orgId || auth.keyId !== keyId || auth.projectScopeId !== `${orgId}/orion`) throw new Error("restored key binding differs");
  const continued = await createSupabaseConversationResolver(db)({ orgId: auth.orgId, keyId: auth.keyId, projectScopeId: auth.projectScopeId, model: "local/check", requestedId: conversationId });
  if (continued !== conversationId) throw new Error("restored conversation cannot continue");
  process.stdout.write("local conversation backup, clean restore, and authenticated continuation passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await clearFixture();
  } catch (error) {
    if (!failure) failure = error;
  }
  if (existsSync(backupPath)) rmSync(backupPath);
}
if (failure) throw failure;
