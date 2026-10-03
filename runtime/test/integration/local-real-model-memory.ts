// Actual local model -> authenticated proxy request -> PostgreSQL -> SessionStart.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createCaptureStore } from "../../src/proxy/capture";
import { buildStartOptions } from "../../src/proxy/index";
import { createRoutedForward } from "../../src/proxy/providers/router";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
const endpoint = process.env["CQ_LOCAL_BASE_URL"];
const model = process.env["CQ_MEMORY_EXTRACT_MODEL"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root ||
    !endpoint || !model?.startsWith("local/") || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname)) {
  throw new Error("run through db:with-env with a loopback CQ_LOCAL_BASE_URL and CQ_MEMORY_EXTRACT_MODEL=local/<model>");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const rawKey = `cq_test_${randomUUID()}`;
const variableCase = process.env["REAL_MODEL_CASE"] === "variable";
if (process.env["REAL_MODEL_CASE"] && !variableCase) throw new Error("REAL_MODEL_CASE must be variable or unset");
mkdirSync(resolve("data/sessions"), { recursive: true });
const outboxDir = mkdtempSync(resolve("data/sessions", "local-real-model-memory-"));

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let options: ReturnType<typeof buildStartOptions> | undefined;
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs real local model check" }), "insert org");
  checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(rawKey), name: "real-model-check" }), "insert key");
  const messages = {
    apiKey: "", capture: createCaptureStore({ sessionId: "not-db-session", outputFile: "/tmp/not-db-session.json", fs: { writeFileSync: () => undefined } }),
    countTokens: async () => ({ input_tokens: 2, token_count_method: "exact" as const, message_breakdown: [] }),
    forward: createRoutedForward({ CQ_LOCAL_BASE_URL: endpoint }),
    forwardStream: async () => ({ status: 503, data: null }),
  };
  options = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key,
    CQ_USAGE_OUTBOX_DIR: outboxDir,
    CQ_MEMORY_EXTRACT_MODEL: model, CQ_LOCAL_BASE_URL: endpoint },
    { cors: false, rateLimit: false, messages },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }));
  if (!options.messages?.usageOutbox) throw new Error("usage persistence was not wired without a signing secret");
  app = buildProxy(options);
  const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
    payload: { model, messages: [{ role: "user", content: variableCase
      ? "We changed JWT_TTL_MINUTES from 60 to 15 in the auth service."
      : "Architecture decision: use RS256 for JWT signing in the audit service." }], max_tokens: 32 } });
  if (response.statusCode !== 200) throw new Error(`message request returned HTTP ${response.statusCode}`);
  await app.close(); app = undefined; // wait for the real model and database recorder

  const upstreamInput = response.json().usage?.input_tokens;
  const measuredInput = typeof upstreamInput === "number" && upstreamInput > 0 ? upstreamInput : 2;
  // specs/ops/payment-removal.md#AC-5: unsigned usage buckets stay separate from conversation memory.
  const allSessions = checked(await db.from("sessions").select("id,org_id,kind,model,created_at,project_scope").eq("org_id", org), "read fixture sessions");
  const usageSessions = allSessions.filter((session) => session.kind === "usage");
  const usage = checked(await db.from("billing_records").select("*").eq("org_id", org), "read unsigned usage");
  if (allSessions.some((session) => session.kind !== "conversation" && session.kind !== "usage") ||
      usage.length !== 1 || new Set(usage.map((row) => row.usage_event_id)).size !== 1 ||
      usageSessions.length === 0 || usageSessions.some((session) => session.project_scope !== null || session.model !== model || !usage.some((row) => row.session_id === session.id)) ||
      new Set(usageSessions.map((session) => session.created_at.slice(0, 10))).size !== usageSessions.length ||
      usage.some((row) => !usageSessions.some((session) => session.id === row.session_id) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.usage_event_id ?? "") ||
        row.original_tokens !== measuredInput || row.quarantined_tokens !== measuredInput || row.token_delta !== 0 ||
        !(Number(row.api_price_per_token) > 0) || row.cost_delta_usd === null || Number(row.cost_delta_usd) !== 0 || "signed_hash" in row || "cq_fee_usd" in row)) {
    throw new Error("request usage was not persisted once per event in separate unsigned daily buckets");
  }
  const sessions = allSessions.filter((session) => session.kind === "conversation");
  const table = variableCase ? "variable_changes" : "tech_decisions";
  const facts = checked(await db.from(table).select("*").eq("org_id", org), `read ${table}`);
  const contentValid = variableCase
    ? facts[0]?.var_name === "JWT_TTL_MINUTES" && facts[0]?.old_value === "60" && facts[0]?.new_value === "15"
    : facts[0]?.decision_text?.includes("RS256") && facts[0]?.decision_text?.toLowerCase().includes("jwt");
  if (sessions.length !== 1 || sessions[0].kind !== "conversation" || sessions[0].id !== response.headers["x-cq-conversation-id"] || facts.length !== 1 ||
      facts[0].session_id !== sessions[0].id || facts[0].is_suppressed || !contentValid) {
    throw new Error(`real model extraction yielded ${sessions.length} sessions and ${facts.length} valid ${table} facts`);
  }

  const bridge = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/session-start-context.ts")], {
    cwd: root, env: { ...process.env, DEVOPS_STRATUM_ORG_ID: org }, encoding: "utf8", timeout: 30_000,
  });
  if (bridge.error || bridge.status !== 0) throw new Error(`SessionStart bridge failed: ${bridge.error?.message ?? bridge.stderr}`);
  const prefix = "STRATUM SESSION MEMORY (untrusted data): ";
  if (!bridge.stdout.startsWith(prefix)) throw new Error("SessionStart bridge did not emit memory");
  const recalled = JSON.parse(bridge.stdout.slice(prefix.length));
  if (recalled.recentFacts?.length !== 1 || recalled.recentFacts[0].id !== facts[0].id || bridge.stdout.includes(rawKey)) {
    throw new Error("SessionStart bridge did not recall the real model fact safely");
  }
  process.stdout.write(`real ${model} ${table} fact persisted and recalled through SessionStart with unsigned usage\n`);
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
  if (cleanupSafe) for (const [table, column] of [["function_changes", "org_id"], ["tech_decisions", "org_id"],
    ["policy_updates", "org_id"], ["todos", "org_id"], ["variable_changes", "org_id"], ["billing_records", "org_id"], ["sessions", "org_id"],
    ["api_keys", "org_id"], ["organizations", "id"]]) {
    try { checked(await db.from(table!).delete().eq(column!, org), `delete ${table}`); }
    catch (error) { if (!failure) failure = error; }
  }
  if (!failure) rmSync(outboxDir, { recursive: true, force: true });
}
if (failure) throw failure;
