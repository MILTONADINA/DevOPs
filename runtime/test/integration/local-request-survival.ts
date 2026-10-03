// One message-derived fact survives 50 later requests and the SessionStart bridge.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createCaptureStore } from "../../src/proxy/capture";
import { buildStartOptions } from "../../src/proxy/index";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from runtime/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
mkdirSync(resolve("data/sessions"), { recursive: true });
const outboxDir = mkdtempSync(resolve("data/sessions", "local-request-survival-"));
const org = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
const marker = `RS256-${org.slice(0, 8)}`;
let modelCalls = 0;
let decisions = 0;
const model = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  modelCalls++;
  const hasDecision = body.includes(marker);
  if (hasDecision) decisions++;
  const facts = hasDecision ? [{ fact_type: "TechDecision", decision_text: `use ${marker} for JWT signing`, domain: "auth", confidence: 0.95 }] : [];
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "local-survival", object: "chat.completion", created: 1, model: "check",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(facts) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
});

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let options: ReturnType<typeof buildStartOptions> | undefined;
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("loopback model did not bind");
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs 50-turn check" }), "insert org");
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
  if (!options.messages?.usageOutbox) throw new Error("usage persistence was not wired without a signing secret");
  app = buildProxy(options);
  for (let turn = 0; turn <= 50; turn++) {
    const content = turn === 0 ? `Decision: use ${marker} for JWT signing` : `unrelated local turn ${turn}`;
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "local/check", messages: [{ role: "user", content }], max_tokens: 32 } });
    if (response.statusCode !== 200) throw new Error(`message turn ${turn} returned HTTP ${response.statusCode}`);
  }
  await app.close(); app = undefined; // drain all asynchronous extraction writes
  // specs/ops/payment-removal.md#AC-5: unsigned usage buckets stay separate from conversation memory.
  const allSessions = checked(await db.from("sessions").select("id,org_id,kind,model,created_at,project_scope").eq("org_id", org), "read fixture sessions");
  const usageSessions = allSessions.filter((session) => session.kind === "usage");
  const usage = checked(await db.from("billing_records").select("*").eq("org_id", org), "read unsigned usage");
  if (allSessions.some((session) => session.kind !== "conversation" && session.kind !== "usage") ||
      usage.length !== 51 || new Set(usage.map((row) => row.usage_event_id)).size !== 51 ||
      usageSessions.length === 0 || usageSessions.some((session) => session.project_scope !== null || session.model !== "local/check" || !usage.some((row) => row.session_id === session.id)) ||
      new Set(usageSessions.map((session) => session.created_at.slice(0, 10))).size !== usageSessions.length ||
      usage.some((row) => !usageSessions.some((session) => session.id === row.session_id) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.usage_event_id ?? "") ||
        row.original_tokens !== 2 || row.quarantined_tokens !== 2 || row.token_delta !== 0 ||
        !(Number(row.api_price_per_token) > 0) || row.cost_delta_usd === null || Number(row.cost_delta_usd) !== 0 || "signed_hash" in row || "cq_fee_usd" in row)) {
    throw new Error("request usage was not persisted once per event in separate unsigned daily buckets");
  }
  const sessions = allSessions.filter((session) => session.kind === "conversation");
  const facts = checked(await db.from("tech_decisions").select("id,session_id,decision_text,is_suppressed").eq("org_id", org), "read decisions");
  if (sessions.length !== 51 || sessions.some((session) => session.kind !== "conversation") ||
      facts.length !== 1 || facts[0].is_suppressed || !facts[0].decision_text.includes(marker) ||
      !sessions.some((session) => session.id === facts[0].session_id) || modelCalls !== 51 || decisions !== 1) {
    throw new Error("first fact did not survive fifty later message requests");
  }

  const bridge = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/session-start-context.ts")], {
    cwd: root, env: { ...process.env, DEVOPS_STRATUM_ORG_ID: org }, encoding: "utf8", timeout: 30_000,
  });
  if (bridge.error || bridge.status !== 0) throw new Error(`SessionStart bridge failed: ${bridge.error?.message ?? bridge.stderr}`);
  const prefix = "STRATUM SESSION MEMORY (untrusted data): ";
  if (!bridge.stdout.startsWith(prefix)) throw new Error("SessionStart bridge did not emit memory");
  const recalled = JSON.parse(bridge.stdout.slice(prefix.length));
  if (recalled.recentFacts?.length !== 1 || recalled.recentFacts[0].id !== facts[0].id ||
      bridge.stdout.includes(rawKey) || bridge.stdout.includes("unrelated local turn")) {
    throw new Error("SessionStart bridge did not recall only the first fact");
  }
  process.stdout.write("local message fact survived 50 later turns and SessionStart recall; 51 conversations and 51 usage events passed\n");
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
  if (cleanupSafe) for (const [table, column] of [["tech_decisions", "org_id"], ["billing_records", "org_id"], ["sessions", "org_id"],
    ["api_keys", "org_id"], ["organizations", "id"]]) {
    try { checked(await db.from(table!).delete().eq(column!, org), `delete ${table}`); }
    catch (error) { if (!failure) failure = error; }
  }
  model.close();
  if (!failure) rmSync(outboxDir, { recursive: true, force: true });
}
if (failure) throw failure;
