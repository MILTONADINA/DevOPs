// Disposable local proof of authenticated project scope on explicit sessions.
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
const org = randomUUID();
const scopes = ["orion", "vega", "legacy"] as const;
const keys = Object.fromEntries(scopes.map((scope) => [scope, `cq_test_${randomUUID()}`])) as Record<(typeof scopes)[number], string>;
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function headers(scope: (typeof scopes)[number]): Record<string, string> {
  return { authorization: `Bearer ${keys[scope]}`, "x-project-scope": "vega" };
}

try {
  checked(await db.from("organizations").insert({ id: org, name: "Project explicit session check" }), "insert org");
  for (const scope of scopes) {
    checked(await db.from("api_keys").insert({ org_id: org, project_scope: scope === "legacy" ? null : scope, key_hash: hashApiKey(keys[scope]), name: scope }), `insert ${scope} key`);
  }
  app = buildProxy(buildStartOptions(
    { CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
  ));
  const spoof = "?org-id=spoofed&project-scope=vega";
  const create = async (scope: (typeof scopes)[number]) => app!.inject({ method: "POST", url: `/v1/sessions${spoof}`, headers: headers(scope), payload: { model: "local/check", project_scope: "vega" } });
  const orion = await create("orion");
  assert(orion.statusCode === 201, `orion create: ${orion.statusCode} ${orion.body}`);
  const orionId = orion.json().id as string;
  const storedOrion = checked(await db.from("sessions").select("project_scope").eq("id", orionId).single(), "read orion scope");
  assert(storedOrion?.project_scope === "orion", "orion creation did not persist authenticated scope");
  assert((await create("vega")).statusCode === 429, "cross-project create bypassed organization cap");

  for (const scope of ["vega", "legacy"] as const) {
    const auth = headers(scope);
    const list = await app.inject({ method: "GET", url: `/v1/sessions${spoof}`, headers: auth });
    assert(list.statusCode === 200 && list.json().sessions.length === 0, `${scope} listed orion's session`);
    for (const [method, path] of [["GET", ""], ["GET", "/stats"], ["DELETE", ""]] as const) {
      const result = await app.inject({ method, url: `/v1/sessions/${orionId}${path}${spoof}`, headers: auth });
      assert(result.statusCode === 404, `${scope} ${method} ${path} crossed into orion`);
    }
  }
  assert((await app.inject({ method: "GET", url: `/v1/sessions/${orionId}/stats`, headers: headers("orion") })).statusCode === 200, "orion cannot read own stats");
  assert((await app.inject({ method: "DELETE", url: `/v1/sessions/${orionId}`, headers: headers("orion") })).statusCode === 200, "orion cannot end own session");

  const vega = await create("vega");
  assert(vega.statusCode === 201, `vega create: ${vega.statusCode} ${vega.body}`);
  const vegaId = vega.json().id as string;
  const storedVega = checked(await db.from("sessions").select("project_scope").eq("id", vegaId).single(), "read vega scope");
  assert(storedVega?.project_scope === "vega", "vega creation did not persist its scope");
  const orionList = await app.inject({ method: "GET", url: "/v1/sessions", headers: headers("orion") });
  assert(orionList.json().sessions.length === 1 && orionList.json().sessions[0].id === orionId, "orion list crossed into vega");
  assert((await app.inject({ method: "DELETE", url: `/v1/sessions/${vegaId}`, headers: headers("vega") })).statusCode === 200, "vega cannot end own session");

  const legacy = await create("legacy");
  assert(legacy.statusCode === 201, `unbound create: ${legacy.statusCode} ${legacy.body}`);
  const legacyId = legacy.json().id as string;
  const storedLegacy = checked(await db.from("sessions").select("project_scope").eq("id", legacyId).single(), "read unbound scope");
  assert(storedLegacy?.project_scope === null, "unbound creation was scoped by client input");
  const preflightUrl = `/v1/sessions/${legacyId}/erasure-preflight${spoof}`;
  assert((await app.inject({ method: "GET", url: preflightUrl, headers: headers("vega") })).statusCode === 403, "project key inspected organization erasure inventory");
  const preflight = await app.inject({ method: "GET", url: preflightUrl, headers: headers("legacy") });
  assert(preflight.statusCode === 200, `organization erasure preflight failed: ${preflight.statusCode} ${preflight.body}`);
  assert(preflight.json().status === "blocked_incomplete_inventory" && preflight.json().inventory.session_id === legacyId &&
    preflight.json().inventory.org_id === org && preflight.json().reasons.includes("stores_not_inventoried"), "erasure preflight overstated readiness or lost scope");
  const legacyList = await app.inject({ method: "GET", url: "/v1/sessions", headers: headers("legacy") });
  assert(legacyList.json().sessions.length === 1 && legacyList.json().sessions[0].id === legacyId, "unbound list crossed into a project");
  assert((await app.inject({ method: "DELETE", url: `/v1/sessions/${legacyId}`, headers: headers("legacy") })).statusCode === 200, "unbound key cannot end own session");
  const concurrent = await Promise.all([create("orion"), create("vega")]);
  assert(concurrent.map((response) => response.statusCode).sort().join(",") === "201,429", "parallel project creates bypassed the organization cap");
  const active = checked(await db.from("sessions").select("id").eq("org_id", org).eq("kind", "explicit").is("ended_at", null), "read active sessions");
  assert(active?.length === 1, "parallel project creates left more than one active session");
  process.stdout.write("local project-scoped explicit sessions and organization cap passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  try {
    checked(await db.from("api_keys").delete().eq("org_id", org), "delete keys");
    checked(await db.from("sessions").delete().eq("org_id", org), "delete sessions");
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) { if (!failure) failure = error; }
}
if (failure) throw failure;
