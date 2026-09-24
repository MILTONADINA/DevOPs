// Disposable local database check of operator-bound API key project identity.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const url = process.env["SUPABASE_URL"];
const serviceKey = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !serviceKey || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const orgA = randomUUID();
const orgB = randomUUID();
const keyVega = `cq_test_${randomUUID()}`;
const keyOtherOrg = `cq_test_${randomUUID()}`;
const keyUnbound = `cq_test_${randomUUID()}`;
let keyOrion: string | undefined;
let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  checked(await db.from("organizations").insert({ id: orgA, name: "Project scope check A" }), "insert org A");
  checked(await db.from("organizations").insert({ id: orgB, name: "Project scope check B" }), "insert org B");

  // Capture the one-time raw key in process memory only; never emit it to logs.
  const created = spawnSync("npm", ["run", "create-api-key", "--", "--org-id", orgA, "--name", "project-scope-check", "--env", "test", "--project-scope", "orion"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  assert(created.status === 0, "operator key creation failed");
  keyOrion = created.stdout.match(/cq_test_[A-Za-z0-9_-]{43}/)?.[0];
  assert(keyOrion, "operator key creation did not return a one-time key");
  const stored = checked(await db.from("api_keys").select("project_scope").eq("key_hash", hashApiKey(keyOrion)).limit(1), "read bound key");
  assert(stored.length === 1 && stored[0]?.project_scope === "orion", "operator scope was not stored");
  const listed = spawnSync("npm", ["run", "api-keys", "--", "--org-id", orgA, "--list"], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert(listed.status === 0 && listed.stdout.includes("[project orion]"), "key management did not show the bound scope");
  assert(!listed.stdout.includes(keyOrion) && !listed.stdout.includes(hashApiKey(keyOrion)), "key management exposed the key or hash");

  checked(await db.from("api_keys").insert({ org_id: orgA, key_hash: hashApiKey(keyVega), name: "vega", project_scope: "vega" }), "insert Vega key");
  checked(await db.from("api_keys").insert({ org_id: orgB, key_hash: hashApiKey(keyOtherOrg), name: "orion B", project_scope: "orion" }), "insert other-org key");
  checked(await db.from("api_keys").insert({ org_id: orgA, key_hash: hashApiKey(keyUnbound), name: "unbound" }), "insert unbound key");
  const rejected = await db.from("api_keys").insert({ org_id: orgA, key_hash: hashApiKey(`cq_test_${randomUUID()}`), name: "invalid", project_scope: "../other" });
  assert(rejected.error, "database accepted an invalid project scope");

  const options = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: serviceKey }, { cors: false, rateLimit: false }, (clientUrl, clientKey) =>
    createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
  );
  app = buildProxy(options);
  app.get("/v1/project-scope-check", (request) => ({ orgId: request.orgId ?? null, scope: request.projectScopeId ?? null }));
  await app.ready();
  const get = async (raw?: string) =>
    app!.inject({
      method: "GET",
      url: "/v1/project-scope-check?project-scope=spoofed",
      headers: raw ? { authorization: `Bearer ${raw}`, "x-project-scope": "spoofed" } : { "x-project-scope": "spoofed" },
    });
  assert((await get()).statusCode === 401, "missing key was accepted");
  const a = await get(keyOrion);
  const v = await get(keyVega);
  const b = await get(keyOtherOrg);
  const legacy = await get(keyUnbound);
  assert(a.statusCode === 200 && a.json().scope === `${orgA}/orion`, "bound key scope was wrong or client spoofed it");
  assert(v.statusCode === 200 && v.json().scope === `${orgA}/vega`, "same-org projects were not isolated");
  assert(b.statusCode === 200 && b.json().scope === `${orgB}/orion`, "same slug crossed organizations");
  assert(legacy.statusCode === 200 && legacy.json().scope === null, "legacy key gained a project scope");
  process.stdout.write("local project API key scope binding passed\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  try {
    checked(await db.from("api_keys").delete().in("org_id", [orgA, orgB]), "delete fixture keys");
    checked(await db.from("organizations").delete().in("id", [orgA, orgB]), "delete fixture organizations");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
