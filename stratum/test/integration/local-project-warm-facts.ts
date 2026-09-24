// Disposable real PostgREST proof of project-bound warm fact storage and reads.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey, resolveApiKeyVia } from "../../src/proxy/auth";
import { createSupabaseMessageMemoryRecorder } from "../../src/proxy/message-memory";
import { createSupabaseMemoryDeps } from "../../src/proxy/routes/memory";
import { createFactExtractor } from "../../src/memory/warm/extractor";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const foreignOrg = randomUUID();
const raw = { orion: `cq_test_${randomUUID()}`, vega: `cq_test_${randomUUID()}`, legacy: `cq_test_${randomUUID()}` };
const ids = {} as Record<keyof typeof raw, string>;
const extractor = createFactExtractor({ complete: async () => JSON.stringify([{ fact_type: "Todo", description: "project scoped check", status: "open", confidence: 0.9 }]) });
const record = createSupabaseMessageMemoryRecorder(db, extractor);
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  checked(await db.from("organizations").insert({ id: org, name: "Project warm fact check" }), "insert org");
  checked(await db.from("organizations").insert({ id: foreignOrg, name: "Project warm fact foreign check" }), "insert foreign org");
  for (const [scope, token] of Object.entries(raw)) {
    checked(await db.from("api_keys").insert({ org_id: org, key_hash: hashApiKey(token), name: scope, project_scope: scope === "legacy" ? null : scope }), `insert ${scope} key`);
  }
  for (const scope of ["orion", "vega", "legacy"] as const) {
    await record({ orgId: org, ...(scope !== "legacy" ? { projectScopeId: `${org}/${scope}` } : {}), model: "local/check", turns: [{ role: "user", content: scope }] });
  }
  const sessions = checked(await db.from("sessions").select("id,project_scope").eq("org_id", org), "read sessions");
  const facts = checked(await db.from("todos").select("id,session_id,project_scope").eq("org_id", org), "read facts");
  assert(sessions.length === 3 && facts.length === 3, "expected three recorded sessions and facts");
  for (const scope of ["orion", "vega", "legacy"] as const) {
    const slug = scope === "legacy" ? null : scope;
    const session = sessions.find((row) => row.project_scope === slug);
    const fact = facts.find((row) => row.project_scope === slug);
    assert(session && fact && fact.session_id === session.id, `${scope} scope was not persisted on its session and fact`);
    ids[scope] = fact.id;
  }
  const forged = await db.from("todos").insert({ org_id: org, session_id: sessions.find((s) => s.project_scope === "orion")!.id, project_scope: "vega", confidence: 0.9, description: "forged" });
  assert(forged.error, "database accepted fact with forged project scope");
  const foreign = await db
    .from("todos")
    .insert({ org_id: foreignOrg, session_id: sessions.find((s) => s.project_scope === "orion")!.id, project_scope: "orion", confidence: 0.9, description: "foreign" });
  assert(foreign.error, "database accepted a fact under a foreign organization");
  const changed = await db
    .from("sessions")
    .update({ project_scope: "vega" })
    .eq("id", sessions.find((s) => s.project_scope === "orion")!.id);
  assert(changed.error, "database allowed a memory session to change projects");
  let badEvent = false;
  try {
    await record({ orgId: org, projectScopeId: `${randomUUID()}/orion`, model: "local/check", turns: [{ role: "user", content: "bad" }] });
  } catch {
    badEvent = true;
  }
  assert(badEvent, "recorder accepted mismatched project identity");

  app = buildProxy({ cors: false, rateLimit: false, auth: { resolve: resolveApiKeyVia(db) }, memory: createSupabaseMemoryDeps(db) });
  for (const scope of ["orion", "vega", "legacy"] as const) {
    const headers = { authorization: `Bearer ${raw[scope]}`, "x-project-scope": "vega" };
    const listed = await app.inject({ method: "GET", url: "/v1/memory/facts?project-scope=vega", headers });
    assert(listed.statusCode === 200 && listed.json().facts.length === 1 && listed.json().facts[0].id === ids[scope], `${scope} key read another project's fact`);
  }
  const wrongDelete = await app.inject({ method: "DELETE", url: `/v1/memory/facts/${ids.vega}?table=todos`, headers: { authorization: `Bearer ${raw.orion}` } });
  assert(wrongDelete.statusCode === 404, "Orion key suppressed Vega fact");
  const rightDelete = await app.inject({ method: "DELETE", url: `/v1/memory/facts/${ids.vega}?table=todos`, headers: { authorization: `Bearer ${raw.vega}` } });
  assert(rightDelete.statusCode === 200, "Vega key could not suppress its own fact");
  process.stdout.write("local project-scoped warm facts and API isolation passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    checked(await db.from("todos").delete().eq("org_id", org), "delete facts");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("api_keys").delete().eq("org_id", org), "delete keys");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
    checked(await db.from("organizations").delete().eq("id", foreignOrg), "delete foreign org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
