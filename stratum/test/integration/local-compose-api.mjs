// Live local API check. Uses the service JWT passed by db:with-env; deletes all
// seeded rows even if an assertion fails. Never prints a credential or fact.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (url !== "http://127.0.0.1:54321" || !key) throw new Error("run through npm run db:with-env");
const db = createClient(url, key, { auth: { persistSession: false } });
const orgId = randomUUID();
const sessionId = randomUUID();
const factId = randomUUID();
const conflictId = randomUUID();

function checked(result, step) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let failure;
try {
  checked(await db.from("organizations").insert({ id: orgId, name: "DevOPs local API check" }), "insert org");
  checked(await db.from("sessions").insert({ id: sessionId, org_id: orgId, model: "local-check" }), "insert session");
  checked(await db.from("function_changes").insert({ id: factId, org_id: orgId, session_id: sessionId, confidence: 0.9, old_name: "oldFn", new_name: "newFn", change_type: "renamed" }), "insert fact");
  const inserted = checked(await db.rpc("persist_audit_results", {
    p_org_id: orgId,
    p_session_id: sessionId,
    p_rows: [{ id: conflictId, fact_table: "function_changes", fact_id: factId, status: "CONFLICT", claimed_state: "oldFn renamed", actual_state: "newFn deleted", conflict_commit: "local-check" }],
  }), "persist audit");
  if (inserted !== 1) throw new Error(`expected one conflict, got ${inserted}`);
  const fact = checked(await db.from("function_changes").select("is_suppressed").eq("id", factId).single(), "read fact");
  const status = checked(await db.from("audit_statuses").select("status").eq("org_id", orgId).eq("fact_id", factId).single(), "read status");
  const conflict = checked(await db.from("audit_conflicts").select("id,acknowledged").eq("id", conflictId).single(), "read alert");
  if (!fact.is_suppressed || status.status !== "CONFLICT" || conflict.id !== conflictId) throw new Error("local audit result did not round-trip");
  process.stdout.write("local service API audit round-trip passed\n");
} catch (error) {
  failure = error;
} finally {
  for (const [table, column, id] of [
    ["audit_statuses", "fact_id", factId], ["audit_conflicts", "id", conflictId],
    ["function_changes", "id", factId], ["sessions", "id", sessionId],
    ["organizations", "id", orgId],
  ]) {
    try {
      const result = await db.from(table).delete().eq(column, id);
      if (result.error && !failure) failure = new Error(`cleanup ${table}: ${result.error.message}`);
    } catch (error) {
      if (!failure) failure = new Error(`cleanup ${table}: ${error.message}`);
    }
  }
}
if (failure) throw failure;
