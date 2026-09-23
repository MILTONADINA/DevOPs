// Authenticated message -> loopback model -> real Git -> atomic local audit RPC.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createCaptureStore } from "../../src/proxy/capture";
import { buildStartOptions } from "../../src/proxy/index";
import { createSupabaseMessageMemoryRecorder } from "../../src/proxy/message-memory";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const scratch = mkdtempSync(join(root, ".workflow/state/local-message-audit-"));
const gitConfig = join(scratch, "gitconfig");
writeFileSync(gitConfig, "");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
const org = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
const suffix = org.slice(0, 8);
const oldName = `oldMessage${suffix}`;
const newName = `newMessage${suffix}`;
let deletionCommit = "";

function run(command: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd: scratch, env: { ...gitEnv, ...extraEnv }, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function commit(source: string, date: string): string {
  writeFileSync(join(scratch, "module.js"), source);
  run("git", ["add", "module.js"]);
  run("git", ["-c", "user.name=DevOPs Check", "-c", "user.email=check@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "local audit fixture"],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return run("git", ["rev-parse", "HEAD"]);
}
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

const model = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  for await (const _chunk of request) { /* drain request */ }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "local-audit", object: "chat.completion", created: 1, model: "check",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify([
      { fact_type: "FunctionChange", old_name: oldName, new_name: newName,
        change_type: "renamed", confidence: 0.9, commit_hash: deletionCommit },
      { fact_type: "Todo", description: "keep local check", status: "open", confidence: 0.9 },
    ]) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
});

let app: ReturnType<typeof buildProxy> | undefined;
let readApp: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  run("git", ["init", "-q"]);
  commit(`export function ${oldName}() { return 1; }\n`, "2026-09-22T10:00:00+00:00");
  commit(`export function ${newName}() { return 1; }\n`, "2026-09-22T10:01:00+00:00");
  deletionCommit = commit("export const marker = 1;\n", "2026-09-22T10:02:00+00:00");
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("loopback model did not bind");
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs request audit check" }), "insert org");
  checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(rawKey), name: "local-check" }), "insert key");
  const messages = {
    apiKey: "", capture: createCaptureStore({ sessionId: "not-db-session", outputFile: "/tmp/not-db-session.json", fs: { writeFileSync: () => undefined } }),
    countTokens: async () => ({ input_tokens: 2, token_count_method: "exact" as const, message_breakdown: [] }),
    forward: async () => ({ status: 200, data: { content: [{ type: "text", text: "assistant answer" }], usage: { input_tokens: 2, output_tokens: 3 } } }),
    forwardStream: async () => ({ status: 503, data: null }),
  };
  const options = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key,
    CQ_MEMORY_EXTRACT_MODEL: "local/check", CQ_LOCAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    CQ_AUDIT_REPO_ROOT: scratch, DEVOPS_STRATUM_PROJECT_ROOT: root },
    { cors: false, rateLimit: false, messages },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }));
  app = buildProxy(options);
  const answer = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
    payload: { model: "local/check", messages: [{ role: "user", content: "latest question" }], max_tokens: 32 } });
  if (answer.statusCode !== 200) throw new Error(`message request returned ${answer.statusCode}`);
  await app.close(); app = undefined;
  const sessions = checked(await db.from("sessions").select("id,kind").eq("org_id", org), "read session");
  const facts = checked(await db.from("function_changes").select("id,session_id,is_suppressed,commit_hash").eq("org_id", org), "read fact");
  const todos = checked(await db.from("todos").select("id,is_suppressed").eq("org_id", org), "read todo");
  const statuses = checked(await db.from("audit_statuses").select("fact_id,status,evidence_commit").eq("org_id", org), "read status");
  const alerts = checked(await db.from("audit_conflicts").select("fact_id,conflict_commit").eq("org_id", org), "read alert");
  if (sessions.length !== 1 || sessions[0].kind !== "memory" || facts.length !== 1 ||
      facts[0].session_id !== sessions[0].id || !facts[0].is_suppressed || facts[0].commit_hash !== null ||
      todos.length !== 1 || todos[0].is_suppressed ||
      statuses.length !== 2 || !statuses.some((row) => row.fact_id === facts[0].id && row.status === "CONFLICT") ||
      !statuses.some((row) => row.fact_id === todos[0].id && row.status === "UNVERIFIED") ||
      alerts.length !== 1 || alerts[0].fact_id !== facts[0].id || alerts[0].conflict_commit !== deletionCommit) {
    throw new Error("request path did not retain scoped conflict suppression, status, and alert");
  }
  readApp = buildProxy(buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } })));
  const headers = { authorization: `Bearer ${rawKey}` };
  const recalled = await readApp.inject({ method: "GET", url: "/v1/memory/facts", headers });
  const statusReply = await readApp.inject({ method: "GET", url: "/v1/memory/audit-statuses", headers });
  const alertReply = await readApp.inject({ method: "GET", url: "/v1/memory/conflicts", headers });
  if (recalled.statusCode !== 200 || recalled.json().facts?.length !== 1 || recalled.json().facts[0].id !== todos[0].id ||
      statusReply.statusCode !== 200 || statusReply.json().statuses?.length !== 2 ||
      alertReply.statusCode !== 200 || alertReply.json().conflicts?.length !== 1) {
    throw new Error("protected memory API exposed conflicted memory or lost audit evidence");
  }
  await readApp.close(); readApp = undefined;
  const failedFactId = randomUUID();
  const failedClient = new Proxy(db, { get(target, prop) {
    if (prop === "rpc") return async () => ({ data: null, error: { message: "forced audit RPC failure" } });
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as SupabaseClient;
  const failingRecorder = createSupabaseMessageMemoryRecorder(failedClient, { extract: async (input) => [{
    id: failedFactId, created_at: new Date().toISOString(), session_id: input.session_id,
    fact_type: "Todo", description: "fail rpc", status: "open", confidence: 0.9,
    is_verified: false, is_suppressed: false,
  }] }, scratch);
  let failed = false;
  try { await failingRecorder({ orgId: org, model: "local/check", turns: [{ role: "user", content: "check" }] }); }
  catch (error) { failed = String(error).includes("forced audit RPC failure"); }
  const stranded = checked(await db.from("todos").select("is_suppressed").eq("id", failedFactId).single(), "read failed-audit fact");
  const missingStatus = checked(await db.from("audit_statuses").select("fact_id").eq("fact_id", failedFactId), "read failed-audit status");
  if (!failed || !stranded.is_suppressed || missingStatus.length !== 0) throw new Error("failed audit exposed an unreviewed fact");
  process.stdout.write("local request-path Git audit conflict passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  try { await readApp?.close(); } catch (error) { if (!failure) failure = error; }
  for (const [table, column, value] of [["audit_statuses", "org_id", org], ["audit_conflicts", "org_id", org],
    ["function_changes", "org_id", org], ["todos", "org_id", org],
    ["api_keys", "org_id", org], ["sessions", "org_id", org], ["organizations", "id", org]]) {
    try { checked(await db.from(table!).delete().eq(column!, value!), `delete ${table}`); }
    catch (error) { if (!failure) failure = error; }
  }
  model.close();
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) throw failure;
