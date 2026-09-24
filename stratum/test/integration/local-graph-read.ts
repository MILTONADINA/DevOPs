// Scoped graph snapshot through the real local database and commercial API key.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { buildStartOptions } from "../../src/proxy/index";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const a = randomUUID();
const b = randomUUID();
const rawA = `cq_test_${randomUUID()}`;
const rawB = `cq_test_${randomUUID()}`;
const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  checked(await db.from("organizations").insert([{ id: a, name: "Graph A" }, { id: b, name: "Graph B" }]), "insert orgs");
  checked(await db.from("api_keys").insert([
    { org_id: a, key_hash: hashApiKey(rawA), name: "graph-a" },
    { org_id: b, key_hash: hashApiKey(rawB), name: "graph-b" },
  ]), "insert keys");
  checked(await db.from("knowledge_entities").insert([
    { id: ids[0], org_id: a, scope_verified: true, kind: "Function", name: "graphAOld" },
    { id: ids[1], org_id: a, scope_verified: true, kind: "Function", name: "graphANew" },
    { id: ids[2], org_id: b, scope_verified: true, kind: "Function", name: "graphBOld" },
    { id: ids[3], org_id: b, scope_verified: true, kind: "Function", name: "graphBNew" },
  ]), "insert entities");
  checked(await db.from("knowledge_edges").insert([
    { org_id: a, scope_verified: true, from_entity: ids[1], to_entity: ids[0], edge_type: "SUPERSEDES" },
    { org_id: b, scope_verified: true, from_entity: ids[3], to_entity: ids[2], edge_type: "SUPERSEDES" },
  ]), "insert edges");

  app = buildProxy(buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key },
    { cors: false, rateLimit: false },
    (clientUrl, clientKey) => createClient(clientUrl, clientKey, { auth: { persistSession: false } })));
  const get = (token: string, path: string) => app!.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${token}` } });
  const response = await get(rawA, `/v1/memory/graph?org-id=${b}&limit=2`);
  const graph = response.json();
  if (response.statusCode !== 200 || graph.entities?.length !== 2 || graph.edges?.length !== 1 ||
      !graph.entities.every((node: { id: string }) => ids.slice(0, 2).includes(node.id)) ||
      graph.edges[0].from_entity !== ids[1] || graph.edges[0].to_entity !== ids[0]) {
    throw new Error("graph A snapshot included a foreign node or edge");
  }
  const one = (await get(rawA, "/v1/memory/graph?limit=1")).json();
  const foreign = (await get(rawB, "/v1/memory/graph?limit=2")).json();
  const noKey = await app.inject({ method: "GET", url: "/v1/memory/graph" });
  if (one.entities?.length !== 1 || one.edges?.length !== 0 ||
      foreign.entities?.length !== 2 || !foreign.entities.every((node: { id: string }) => ids.slice(2).includes(node.id)) ||
      noKey.statusCode !== 401) throw new Error("graph limit or API-key scope failed");
  process.stdout.write("local graph snapshot obeyed API-key scope and bounded node/edge reads\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  for (const table of ["knowledge_edges", "knowledge_entities", "api_keys"]) {
    for (const org of [a, b]) {
      try { checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`); }
      catch (error) { if (!failure) failure = error; }
    }
  }
  for (const org of [a, b]) {
    try { checked(await db.from("organizations").delete().eq("id", org), "delete org"); }
    catch (error) { if (!failure) failure = error; }
  }
}
if (failure) throw failure;
