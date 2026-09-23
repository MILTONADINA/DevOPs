// Actual local model -> authenticated proxy request -> PostgreSQL -> SessionStart.
import { randomUUID } from "node:crypto";
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

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

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
  app = buildProxy(buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key,
    CQ_MEMORY_EXTRACT_MODEL: model, CQ_LOCAL_BASE_URL: endpoint },
    { cors: false, rateLimit: false, messages },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } })));
  const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${rawKey}` },
    payload: { model, messages: [{ role: "user", content: variableCase
      ? "We changed JWT_TTL_MINUTES from 60 to 15 in the auth service."
      : "Architecture decision: use RS256 for JWT signing in the audit service." }], max_tokens: 32 } });
  if (response.statusCode !== 200) throw new Error(`message request returned HTTP ${response.statusCode}`);
  await app.close(); app = undefined; // wait for the real model and database recorder

  const sessions = checked(await db.from("sessions").select("id,kind").eq("org_id", org), "read sessions");
  const table = variableCase ? "variable_changes" : "tech_decisions";
  const facts = checked(await db.from(table).select("*").eq("org_id", org), `read ${table}`);
  const contentValid = variableCase
    ? facts[0]?.var_name === "JWT_TTL_MINUTES" && facts[0]?.old_value === "60" && facts[0]?.new_value === "15"
    : facts[0]?.decision_text?.includes("RS256") && facts[0]?.decision_text?.toLowerCase().includes("jwt");
  if (sessions.length !== 1 || sessions[0].kind !== "memory" || facts.length !== 1 ||
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
  process.stdout.write(`real ${model} ${table} fact persisted and recalled through SessionStart\n`);
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  for (const [table, column] of [["function_changes", "org_id"], ["tech_decisions", "org_id"],
    ["policy_updates", "org_id"], ["todos", "org_id"], ["variable_changes", "org_id"], ["api_keys", "org_id"],
    ["sessions", "org_id"], ["organizations", "id"]]) {
    try { checked(await db.from(table!).delete().eq(column!, org), `delete ${table}`); }
    catch (error) { if (!failure) failure = error; }
  }
}
if (failure) throw failure;
