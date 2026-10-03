// Real proxy route -> loopback extraction model -> local PostgreSQL fact check.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createCaptureStore } from "../../src/proxy/capture";
import { buildStartOptions } from "../../src/proxy/index";
import { createSupabaseMessageMemoryRecorder } from "../../src/proxy/message-memory";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from runtime/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
mkdirSync(resolve("data/sessions"), { recursive: true });
const outboxDir = mkdtempSync(resolve("data/sessions", "local-message-memory-"));
const org = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
let sessionId: string | undefined;
let modelCalls = 0;
const model = createServer(async (request, response) => {
  modelCalls++;
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const sent = JSON.parse(body);
  const prompt = JSON.stringify(sent);
  if (!prompt.includes("latest question") || !prompt.includes("assistant answer") || prompt.includes("older question")) {
    response.writeHead(400).end();
    return;
  }
  if (sent.temperature !== 0 || sent.max_tokens !== 1024 ||
      sent.chat_template_kwargs?.enable_thinking !== false || sent.chat_template_kwargs?.preserve_thinking !== false) {
    response.writeHead(400).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "local-check", object: "chat.completion", created: 1, model: "check",
    choices: [{ index: 0, message: { role: "assistant", content: `${modelCalls === 2 ? "Thinking: tentative candidate " : ""}${JSON.stringify([
      { fact_type: "FunctionChange", old_name: modelCalls === 2 ? "truncatedLocal" : "oldLocal", new_name: "newLocal", change_type: "renamed", confidence: 0.9,
        org_id: randomUUID(), session_id: randomUUID(), source_exchange_id: randomUUID(), is_suppressed: true },
    ])}${modelCalls === 2 ? " Final answer: [{\"fact_type\":\"FunctionChange\"" : ""}` }, finish_reason: modelCalls === 2 ? "length" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
});

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let options: ReturnType<typeof buildStartOptions> | undefined;
let app: ReturnType<typeof buildProxy> | undefined;
let readApp: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("loopback model did not bind");
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs message memory check" }), "insert org");
  checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(rawKey), name: "local-check" }), "insert key");
  const messages = {
    apiKey: "", capture: createCaptureStore({ sessionId: "not-db-session", outputFile: "/tmp/not-db-session.json", fs: { writeFileSync: () => undefined } }),
    countTokens: async () => ({ input_tokens: 2, token_count_method: "exact" as const, message_breakdown: [] }),
    forward: async () => ({ status: 200, data: { content: [{ type: "text", text: "assistant answer" }], usage: { input_tokens: 2, output_tokens: 3 } } }),
    forwardStream: async () => ({ status: 503, data: null }),
  };
  options = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key,
    CQ_USAGE_OUTBOX_DIR: outboxDir,
    CQ_MEMORY_EXTRACT_MODEL: "local/check", CQ_LOCAL_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    { cors: false, rateLimit: false, messages },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }));
  const recorder = options.messages?.recordMemory;
  if (!recorder || !options.messages) throw new Error("commercial recorder was not wired");
  let exchangeId: string | undefined;
  options.messages.recordMemory = async (event) => { exchangeId ??= event.exchangeId; await recorder(event); };
  if (!options.messages?.usageOutbox) throw new Error("usage persistence was not wired without a signing secret");
  app = buildProxy(options);
  const answer = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
    payload: { model: "local/check", messages: [{ role: "user", content: "older question" },
      { role: "assistant", content: "older answer" }, { role: "user", content: "latest question" }], max_tokens: 32 } });
  if (answer.statusCode !== 200) throw new Error(`message request returned ${answer.statusCode}`);
  const truncated = await app.inject({ method: "POST", url: "/v1/messages",
    headers: { authorization: `Bearer ${rawKey}`, "x-cq-conversation-id": String(answer.headers["x-cq-conversation-id"]) },
    payload: { model: "local/check", messages: [{ role: "user", content: "latest question" }], max_tokens: 32 } });
  if (truncated.statusCode !== 200 || truncated.headers["x-cq-conversation-id"] !== answer.headers["x-cq-conversation-id"]) {
    throw new Error("truncated extraction changed the upstream response or conversation");
  }
  await app.close();
  app = undefined;
  // specs/ops/payment-removal.md#AC-5: unsigned usage buckets stay separate from conversation memory.
  const allSessions = checked(await db.from("sessions").select("id,org_id,kind,model,created_at,project_scope").eq("org_id", org), "read fixture sessions");
  const usageSessions = allSessions.filter((session) => session.kind === "usage");
  const usage = checked(await db.from("billing_records").select("*").eq("org_id", org), "read unsigned usage");
  if (allSessions.some((session) => session.kind !== "conversation" && session.kind !== "usage") ||
      usage.length !== 2 || new Set(usage.map((row) => row.usage_event_id)).size !== 2 ||
      usageSessions.length === 0 || usageSessions.some((session) => session.project_scope !== null || session.model !== "local/check" || !usage.some((row) => row.session_id === session.id)) ||
      new Set(usageSessions.map((session) => session.created_at.slice(0, 10))).size !== usageSessions.length ||
      usage.some((row) => !usageSessions.some((session) => session.id === row.session_id) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.usage_event_id ?? "") ||
        row.original_tokens !== 2 || row.quarantined_tokens !== 2 || row.token_delta !== 0 ||
        !(Number(row.api_price_per_token) > 0) || row.cost_delta_usd === null || Number(row.cost_delta_usd) !== 0 || "signed_hash" in row || "cq_fee_usd" in row)) {
    throw new Error("request usage was not persisted once per event in separate unsigned daily buckets");
  }
  const sessions = allSessions.filter((session) => session.kind === "conversation");
  if (sessions.length !== 1 || sessions[0].kind !== "conversation" || sessions[0].org_id !== org ||
      sessions[0].id !== answer.headers["x-cq-conversation-id"] || sessions[0].id === "not-db-session") {
    throw new Error("request did not use one trusted conversation session");
  }
  sessionId = sessions[0].id;
  const facts = checked(await db.from("function_changes").select("id,org_id,session_id,source_exchange_id,is_suppressed,old_name").eq("org_id", org), "read memory fact");
  if (facts.length !== 1 || facts[0].session_id !== sessionId || facts[0].source_exchange_id !== exchangeId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(exchangeId ?? "") ||
      facts[0].old_name !== "oldLocal" || facts[0].is_suppressed || modelCalls !== 2) {
    throw new Error("completed fact was not stored alone under the trusted session");
  }
  let extracted = false;
  const rejectForeign = createSupabaseMessageMemoryRecorder(db, { extract: async () => { extracted = true; return []; } });
  const keys = checked(await db.from("api_keys").select("id").eq("org_id", org), "read authenticated key");
  if (keys.length !== 1) throw new Error("expected one authenticated key");
  for (const identity of [{ keyId: randomUUID() }, { projectScopeId: `${org}/vega`, keyId: keys[0].id }]) {
    let rejected = false;
    try {
      await rejectForeign({ orgId: org, conversationId: sessionId, ...identity, model: "local/check",
        turns: [{ role: "user", content: "forged" }] });
    } catch { rejected = true; }
    if (!rejected || extracted) throw new Error("foreign conversation identity reached extraction");
  }
  readApp = buildProxy(buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } })));
  const headers = { authorization: `Bearer ${rawKey}` };
  const memory = await readApp.inject({ method: "GET", url: "/v1/memory/facts", headers });
  const visible = await readApp.inject({ method: "GET", url: "/v1/sessions", headers });
  if (memory.statusCode !== 200 || memory.json().facts?.[0]?.id !== facts[0].id ||
      memory.json().facts?.[0]?.source_exchange_id !== undefined ||
      visible.statusCode !== 200 || visible.json().sessions?.length !== 0) {
    throw new Error("memory fact visibility or explicit-session isolation failed");
  }
  const legacySessionId = randomUUID();
  checked(await db.from("sessions").insert({ id: legacySessionId, org_id: org, kind: "memory", model: "local/check", ended_at: new Date().toISOString() }), "insert legacy session");
  const legacyFactId = randomUUID();
  const legacyFact = { id: legacyFactId, org_id: org, session_id: legacySessionId, confidence: 0.9,
    old_name: "legacy", change_type: "renamed" };
  checked(await db.from("function_changes").insert(legacyFact), "insert legacy fact");
  const legacy = checked(await db.from("function_changes").select("source_exchange_id").eq("id", legacyFactId).single(), "read legacy fact");
  if (legacy.source_exchange_id !== null) throw new Error("legacy fact acquired exchange provenance");
  if (!(await db.from("function_changes").insert({ ...legacyFact, id: randomUUID(), source_exchange_id: randomUUID() })).error ||
      !(await db.from("function_changes").update({ source_exchange_id: randomUUID() }).eq("id", facts[0].id)).error ||
      !(await db.from("function_changes").update({ session_id: legacySessionId }).eq("id", facts[0].id)).error) {
    throw new Error("database accepted forged or rewritten exchange provenance");
  }
  process.stdout.write("local conversation fact provenance, identity rejection, and 2 unsigned usage events passed\n");
} catch (error) {
  failure = error;
} finally {
  let cleanupSafe = true;
  try { await app?.close(); } catch (error) { cleanupSafe = false; if (!failure) failure = error; }
  try {
    await options?.messages?.usageOutbox?.close();
    if (readdirSync(outboxDir).length !== 0) {
      cleanupSafe = false;
      if (!failure) failure = new Error(`usage outbox did not drain; fixture retained at ${outboxDir}`);
    }
  } catch (error) { cleanupSafe = false; if (!failure) failure = error; }
  if (!cleanupSafe) process.stderr.write(`fixture ${org} retained for recovery; usage outbox: ${outboxDir}\n`);
  try { await readApp?.close(); } catch (error) { if (!failure) failure = error; }
  if (cleanupSafe) try {
    checked(await db.from("function_changes").delete().eq("org_id", org), "delete facts");
    checked(await db.from("billing_records").delete().eq("org_id", org), "delete fixture usage");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("api_keys").delete().eq("org_id", org), "delete key");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) { if (!failure) failure = error; }
  model.close();
  if (!failure) rmSync(outboxDir, { recursive: true, force: true });
}
if (failure) throw failure;
