// Disposable HTTP and SessionStart read proof for grounded project references.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey, resolveApiKeyVia } from "../../src/proxy/auth";
import { createSupabaseMemoryDeps } from "../../src/proxy/routes/memory";
import { retrieveSessionContext } from "../../scripts/session-start-context";

const root = realpathSync(resolve(process.cwd(), ".."));
const url = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !serviceKey || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) throw new Error("use db:with-env");
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const org = randomUUID(),
  otherOrg = randomUUID();
const session = randomUUID(),
  otherSession = randomUUID();
const apiKey = `cq_test_${randomUUID()}`;
const target = randomUUID(),
  otherReference = randomUUID(),
  suppressed = randomUUID(),
  foreign = randomUUID();
const targetText = "RUNBOOK_RECOVERY.md";
const now = new Date().toISOString();
function check<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(detail);
}
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  check(
    await db.from("organizations").insert([
      { id: org, name: "reference reads" },
      { id: otherOrg, name: "foreign reference reads" },
    ]),
    "organizations",
  );
  check(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(apiKey), name: "orion", project_scope: "orion" }), "key");
  check(
    await db.from("sessions").insert([
      { id: session, org_id: org, project_scope: "orion", model: "fixture" },
      { id: otherSession, org_id: otherOrg, project_scope: "orion", model: "fixture" },
    ]),
    "sessions",
  );
  check(
    await db.from("operational_references").insert([
      {
        id: target,
        org_id: org,
        session_id: session,
        project_scope: "orion",
        created_at: "2026-01-01T00:00:00Z",
        confidence: 0.9,
        subject: "recovery runbook",
        reference: targetText,
        is_suppressed: false,
      },
      { id: otherReference, created_at: now, org_id: org, session_id: session, project_scope: "orion", confidence: 0.9, subject: "other route", reference: "/other", is_suppressed: false },
      { id: suppressed, created_at: now, org_id: org, session_id: session, project_scope: "orion", confidence: 0.9, subject: "hidden", reference: "hidden-ref", is_suppressed: true },
      { id: foreign, created_at: now, org_id: otherOrg, session_id: otherSession, project_scope: "orion", confidence: 0.9, subject: "foreign", reference: "foreign-ref", is_suppressed: false },
    ]),
    "references",
  );
  const fillers = Array.from({ length: 201 }, (_, i) => ({ org_id: org, session_id: session, project_scope: "orion", confidence: 0.9, subject: `filler ${i}`, reference: `filler-${i}` }));
  check(await db.from("operational_references").insert(fillers), "newer references");
  check(
    await db.rpc("persist_audit_results", {
      p_org_id: org,
      p_session_id: session,
      p_rows: [{ fact_table: "operational_references", fact_id: target, status: "UNVERIFIED" }],
    }),
    "audit reference",
  );
  app = buildProxy({ cors: false, rateLimit: false, auth: { resolve: resolveApiKeyVia(db) }, memory: createSupabaseMemoryDeps(db) });
  const api = await app.inject({ method: "GET", url: "/v1/memory/facts?limit=250", headers: { authorization: `Bearer ${apiKey}` } });
  assert(api.statusCode === 200, `API status ${api.statusCode}`);
  const audit = await app.inject({ method: "GET", url: "/v1/memory/audit-statuses", headers: { authorization: `Bearer ${apiKey}` } });
  assert(audit.statusCode === 200 && JSON.stringify(audit.json()).includes(target), "project API missed reference audit status");
  const listed = api.json().facts as { id: string; fact_type: string }[];
  assert(listed.some((fact) => fact.fact_type === "OperationalReference") && !listed.some((fact) => [suppressed, foreign].includes(fact.id)), "API scope or type mismatch");
  const output = await retrieveSessionContext(
    { projectRoot: root, boundRoot: root, orgId: org, projectScope: "orion", supabaseUrl: url, serviceKey, allowlistText: "127.0.0.1", task: targetText },
    {
      makeClient: () => db,
      encode: async () => [1, 0],
      encodeMany: async (texts) => texts.map((value) => (value.includes(targetText) ? [1, 0] : [0, 1])),
    },
  );
  assert(output, "SessionStart rejected trusted binding");
  const context = JSON.parse(output);
  assert(!context.recentFacts.some((fact: { id: string }) => fact.id === target), "old reference was in bounded recent set");
  assert(
    context.relevantFacts.some((fact: { id: string }) => fact.id === target),
    "lexical SessionStart missed old exact reference",
  );
  assert(!output.includes("hidden-ref") && !output.includes("foreign-ref"), "SessionStart leaked excluded reference");
  process.stdout.write("operational reference API and old lexical SessionStart recall passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  for (const [table, column, value] of [
    ["audit_statuses", "org_id", org],
    ["operational_references", "org_id", org],
    ["operational_references", "org_id", otherOrg],
    ["sessions", "org_id", org],
    ["sessions", "org_id", otherOrg],
    ["api_keys", "org_id", org],
    ["organizations", "id", org],
    ["organizations", "id", otherOrg],
  ]) {
    try {
      check(await db.from(table!).delete().eq(column!, value!), `cleanup ${table}`);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
