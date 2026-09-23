// Disposable real-database check of the commercial startup wiring and memory API.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const orgs = [randomUUID(), randomUUID()];
const sessions = [randomUUID(), randomUUID()];
const facts = [randomUUID(), randomUUID()];
const activeFacts = [randomUUID(), randomUUID()];
const conflicts = [randomUUID(), randomUUID()];
const keys = [`cq_test_${randomUUID()}`, `cq_test_${randomUUID()}`];

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function clearRows(): Promise<void> {
  for (const [table, column, values] of [
    ["audit_statuses", "fact_id", facts], ["audit_conflicts", "id", conflicts],
    ["function_changes", "id", [...facts, ...activeFacts]], ["api_keys", "org_id", orgs],
    ["sessions", "id", sessions], ["organizations", "id", orgs],
  ] as const) {
    checked(await db.from(table).delete().in(column, [...values]), `delete ${table}`);
  }
}

let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  for (const i of [0, 1]) {
    const orgId = orgs[i]!;
    const sessionId = sessions[i]!;
    const factId = facts[i]!;
    checked(await db.from("organizations").insert({ id: orgId, name: `DevOPs local proxy check ${i}` }), "insert org");
    checked(await db.from("sessions").insert({ id: sessionId, org_id: orgId, model: "local-check" }), "insert session");
    checked(await db.from("api_keys").insert({ org_id: orgId, key_hash: hashApiKey(keys[i]!), name: "local-check" }), "insert key");
    checked(await db.from("function_changes").insert({
      id: factId, org_id: orgId, session_id: sessionId, confidence: 0.9,
      old_name: `oldLocal${i}`, new_name: `newLocal${i}`, change_type: "renamed",
    }), "insert fact");
    checked(await db.from("function_changes").insert({
      id: activeFacts[i], org_id: orgId, session_id: sessionId, confidence: 0.9,
      old_name: `activeLocal${i}`, new_name: `liveLocal${i}`, change_type: "renamed",
    }), "insert active fact");
    const inserted = checked(await db.rpc("persist_audit_results", {
      p_org_id: orgId, p_session_id: sessionId,
      p_rows: [{ id: conflicts[i], fact_table: "function_changes", fact_id: factId,
        status: "CONFLICT", claimed_state: "renamed", actual_state: "deleted", conflict_commit: "local-check" }],
    }), "persist audit");
    assert(inserted === 1, "expected one local conflict");
  }

  const options = buildStartOptions(
    { CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
  );
  app = buildProxy(options);
  await app.ready();

  const get = async (path: string, rawKey?: string) => {
    const response = await app!.inject({ method: "GET", url: path,
      headers: rawKey ? { authorization: `Bearer ${rawKey}` } : {} });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  const missing = await get("/v1/memory/facts");
  assert(missing.status === 401, "missing key was accepted");
  const encoded = await get("/%76%31/memory/facts", keys[0]);
  assert(encoded.status === 200, "encoded protected path failed");

  for (const i of [0, 1]) {
    const other = 1 - i;
    for (const [path, field, expectedId] of [
      ["facts", "facts", activeFacts[i]],
      ["conflicts", "conflicts", conflicts[i]],
      ["audit-statuses", "statuses", facts[i]],
    ] as const) {
      const result = await get(`/v1/memory/${path}?org-id=${orgs[other]}`, keys[i]);
      assert(result.status === 200, `${path} request failed`);
      const rows = result.body[field] as Array<Record<string, unknown>>;
      assert(rows.length === 1, `${path} returned unexpected row count`);
      assert((rows[0]?.[path === "conflicts" ? "id" : path === "audit-statuses" ? "fact_id" : "id"]) === expectedId, `${path} leaked a foreign row`);
    }
  }

  const foreignDelete = await app.inject({ method: "DELETE",
    url: `/v1/memory/facts/${facts[1]}?table=function_changes&org-id=${orgs[1]}`,
    headers: { authorization: `Bearer ${keys[0]}` } });
  assert(foreignDelete.statusCode === 404, "foreign fact suppression accepted");
  checked(await db.from("api_keys").update({ is_active: false }).eq("key_hash", hashApiKey(keys[0]!)), "deactivate key");
  const inactive = await get("/v1/memory/conflicts", keys[0]);
  assert(inactive.status === 401, "inactive key was accepted");
  process.stdout.write("local commercial memory API organization binding passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  try { await clearRows(); } catch (error) { if (!failure) failure = error; }
}
if (failure) throw failure;
