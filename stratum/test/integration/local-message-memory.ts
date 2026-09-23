// Real proxy route -> loopback extraction model -> local PostgreSQL fact check.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createCaptureStore } from "../../src/proxy/capture";
import { buildStartOptions } from "../../src/proxy/index";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
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
  const prompt = JSON.stringify(JSON.parse(body));
  if (!prompt.includes("latest question") || !prompt.includes("assistant answer") || prompt.includes("older question")) {
    response.writeHead(400).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "local-check", object: "chat.completion", created: 1, model: "check",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify([
      { fact_type: "FunctionChange", old_name: "oldLocal", new_name: "newLocal", change_type: "renamed", confidence: 0.9,
        org_id: randomUUID(), session_id: randomUUID(), is_suppressed: true },
    ]) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
});

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

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
  const options = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key,
    CQ_MEMORY_EXTRACT_MODEL: "local/check", CQ_LOCAL_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    { cors: false, rateLimit: false, messages },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }));
  app = buildProxy(options);
  const answer = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
    payload: { model: "local/check", messages: [{ role: "user", content: "older question" },
      { role: "assistant", content: "older answer" }, { role: "user", content: "latest question" }], max_tokens: 32 } });
  if (answer.statusCode !== 200) throw new Error(`message request returned ${answer.statusCode}`);
  await app.close();
  app = undefined;
  const sessions = checked(await db.from("sessions").select("id,org_id,kind").eq("org_id", org), "read memory session");
  if (sessions.length !== 1 || sessions[0].kind !== "memory" || sessions[0].org_id !== org || sessions[0].id === "not-db-session") {
    throw new Error("request did not create one trusted memory session");
  }
  sessionId = sessions[0].id;
  const facts = checked(await db.from("function_changes").select("id,org_id,session_id,is_suppressed,old_name").eq("org_id", org), "read memory fact");
  if (facts.length !== 1 || facts[0].session_id !== sessionId || facts[0].old_name !== "oldLocal" || facts[0].is_suppressed || modelCalls !== 1) {
    throw new Error("typed fact was not stored under the trusted session");
  }
  readApp = buildProxy(buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } })));
  const headers = { authorization: `Bearer ${rawKey}` };
  const memory = await readApp.inject({ method: "GET", url: "/v1/memory/facts", headers });
  const visible = await readApp.inject({ method: "GET", url: "/v1/sessions", headers });
  if (memory.statusCode !== 200 || memory.json().facts?.[0]?.id !== facts[0].id ||
      visible.statusCode !== 200 || visible.json().sessions?.length !== 0) {
    throw new Error("memory fact visibility or explicit-session isolation failed");
  }
  process.stdout.write("local message memory session and fact persistence passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  try { await readApp?.close(); } catch (error) { if (!failure) failure = error; }
  try {
    checked(await db.from("function_changes").delete().eq("org_id", org), "delete facts");
    checked(await db.from("api_keys").delete().eq("org_id", org), "delete key");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) { if (!failure) failure = error; }
  model.close();
}
if (failure) throw failure;
