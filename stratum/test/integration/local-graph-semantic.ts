/** Real local Postgres proof of scoped semantic graph search and stale-pointer filtering. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createSupabaseMemoryDeps } from "../../src/proxy/routes/memory";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const own = randomUUID(),
  foreign = randomUUID(),
  hit = randomUUID(),
  neighbor = randomUUID(),
  alien = randomUUID();
const raw = `cq_test_${randomUUID()}`;
const vector = (a: number, b: number): number[] => [a, b, ...Array(382).fill(0)];
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  checked(
    await db.from("organizations").insert([
      { id: own, name: "Semantic graph A" },
      { id: foreign, name: "Semantic graph B" },
    ]),
    "orgs",
  );
  checked(await db.from("api_keys").insert({ org_id: own, key_hash: hashApiKey(raw), name: "semantic-graph" }), "key");
  checked(
    await db.from("knowledge_entities").insert([
      { id: hit, org_id: own, kind: "Function", name: "src/auth.ts#verify", summary: "Checks a bearer credential" },
      { id: neighbor, org_id: own, kind: "File", name: "src/auth.ts" },
      { id: alien, org_id: foreign, kind: "Function", name: "src/foreign.ts#verify" },
    ]),
    "entities",
  );
  checked(await db.from("knowledge_edges").insert({ org_id: own, from_entity: neighbor, to_entity: hit, edge_type: "DECLARES" }), "edge");
  checked(
    await db.from("memory_vectors").insert([
      { org_id: own, source_type: "entity", source_ref: hit, embedding: vector(0.9, 0.1) },
      { org_id: own, source_type: "entity", source_ref: randomUUID(), embedding: vector(1, 0) },
      { org_id: foreign, source_type: "entity", source_ref: alien, embedding: vector(1, 0) },
    ]),
    "vectors",
  );
  app = buildProxy({
    cors: false,
    rateLimit: false,
    auth: { resolve: async (token) => (token === raw ? { orgId: own, keyId: "fixture" } : null) },
    memory: createSupabaseMemoryDeps(db, async () => vector(1, 0)),
  });
  const response = await app.inject({ method: "GET", url: `/v1/memory/graph/search?mode=semantic&q=credential&org-id=${foreign}`, headers: { authorization: `Bearer ${raw}` } });
  const result = response.json();
  if (
    response.statusCode !== 200 ||
    result.matches?.length !== 1 ||
    result.matches[0] !== hit ||
    result.entities?.length !== 2 ||
    result.edges?.length !== 1 ||
    result.entities.some((entity: { id: string }) => entity.id === alien)
  ) {
    throw new Error(`semantic graph search leaked or missed a row: ${response.payload}`);
  }
  await app.close();
  app = buildProxy({
    cors: false,
    rateLimit: false,
    auth: { resolve: async (token) => (token === raw ? { orgId: own, keyId: "fixture" } : null) },
    memory: createSupabaseMemoryDeps(db),
  });
  const offline = await app.inject({ method: "GET", url: "/v1/memory/graph/search?mode=semantic&q=credential", headers: { authorization: `Bearer ${raw}` } });
  if (offline.statusCode !== 200 || offline.json().matches?.[0] !== hit) throw new Error(`offline semantic query failed: ${offline.payload}`);
  process.stdout.write("local semantic graph search excluded foreign and stale vectors and returned the scoped neighbor\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  for (const table of ["memory_vectors", "knowledge_edges", "knowledge_entities", "api_keys"]) {
    for (const org of [own, foreign]) {
      try {
        checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`);
      } catch (error) {
        if (!failure) failure = error;
      }
    }
  }
  for (const org of [own, foreign]) {
    try {
      checked(await db.from("organizations").delete().eq("id", org), "delete org");
    } catch (error) {
      if (!failure) failure = error;
    }
  }
}
if (failure) throw failure;
