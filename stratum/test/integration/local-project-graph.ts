// Disposable proof that commercial graph reads and writes isolate projects within one organization.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildProxy } from "../../src/proxy/app";
import { hashApiKey } from "../../src/proxy/auth";
import { createSupabaseMemoryDeps } from "../../src/proxy/routes/memory";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || !process.env["DEVOPS_STRATUM_PROJECT_ROOT"]) throw new Error("run through db:with-env from stratum/");
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const scopes = ["orion", "vega", "legacy"] as const;
const rows = Object.fromEntries(scopes.map((scope) => [scope, {
  session: randomUUID(), file: randomUUID(), fn: randomUUID(), edge: randomUUID(), fact: randomUUID(), rawKey: `cq_test_${randomUUID()}`,
}])) as Record<(typeof scopes)[number], { session: string; file: string; fn: string; edge: string; fact: string; rawKey: string }>;
const uncertain = randomUUID();
const privateFile = randomUUID();
const vector = [1, ...Array(383).fill(0)] as number[];
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
  checked(await db.from("organizations").insert({ id: org, name: "Project graph check" }), "insert org");
  for (const scope of scopes) {
    const item = rows[scope];
    const projectScope = scope === "legacy" ? null : scope;
    checked(await db.from("sessions").insert({ id: item.session, org_id: org, project_scope: projectScope, model: "local/check" }), `insert ${scope} session`);
    checked(await db.from("api_keys").insert({ org_id: org, project_scope: projectScope, key_hash: hashApiKey(item.rawKey), name: scope }), `insert ${scope} key`);
    checked(await db.from("knowledge_entities").insert([
      { id: item.file, org_id: org, project_scope: projectScope, scope_verified: true, session_id: item.session, kind: "File", name: "src/auth.ts", file_path: "src/auth.ts", summary: `${scope} source` },
      { id: item.fn, org_id: org, project_scope: projectScope, scope_verified: true, session_id: item.session, kind: "Function", name: "verifyToken", summary: `${scope} function` },
    ]), `insert ${scope} entities`);
    checked(await db.from("knowledge_edges").insert({ id: item.edge, org_id: org, project_scope: projectScope, scope_verified: true, session_id: item.session, from_entity: item.file, to_entity: item.fn, edge_type: "DEPENDS_ON" }), `insert ${scope} edge`);
    checked(await db.from("function_changes").insert({ id: item.fact, org_id: org, project_scope: projectScope, session_id: item.session, confidence: 0.9, old_name: scope, change_type: "deprecated", file_path: "src/auth.ts" }), `insert ${scope} fact`);
    checked(await db.from("memory_vectors").insert({ org_id: org, session_id: item.session, source_type: "entity", source_ref: item.file, embedding: vector }), `insert ${scope} vector`);
  }
  checked(await db.from("knowledge_entities").insert({ id: privateFile, org_id: org, project_scope: "vega", scope_verified: true, kind: "File", name: "src/private.ts", file_path: "src/private.ts", created_at: "2020-01-01T00:00:00Z" }), "insert vega-only File");
  checked(await db.from("knowledge_entities").insert({ id: uncertain, org_id: org, kind: "File", name: "src/old.ts", file_path: "src/old.ts", summary: "unknown old source" }), "insert uncertain File");

  const wrongEdge = await db.from("knowledge_edges").insert({ org_id: org, project_scope: "orion", scope_verified: true, from_entity: rows.orion.file, to_entity: rows.vega.fn, edge_type: "DEPENDS_ON" });
  assert(wrongEdge.error, "database accepted a cross-project edge");
  const wrongLink = await db.from("knowledge_entity_sessions").insert({ org_id: org, entity_id: rows.orion.file, session_id: rows.vega.session });
  assert(wrongLink.error, "database accepted a cross-project session provenance link");
  const wrongSourceLink = await db.from("source_fact_links").insert({ org_id: org, file_entity_id: rows.orion.file, function_change_id: rows.vega.fact });
  assert(wrongSourceLink.error, "database accepted a cross-project File-to-fact link");
  assert((await db.from("knowledge_entities").update({ project_scope: "vega" }).eq("id", rows.orion.file)).error, "database changed an entity's project identity");
  assert((await db.from("knowledge_edges").update({ project_scope: "vega" }).eq("id", rows.orion.edge)).error, "database changed an edge's project identity");

  app = buildProxy({ cors: false, rateLimit: false, auth: { resolve: async (raw) => {
    const scope = scopes.find((name) => rows[name].rawKey === raw);
    return scope ? { orgId: org, keyId: scope, ...(scope !== "legacy" ? { projectScopeId: `${org}/${scope}` } : {}) } : null;
  } }, memory: createSupabaseMemoryDeps(db, async () => vector) });
  for (const scope of scopes) {
    const item = rows[scope];
    const headers = { authorization: `Bearer ${item.rawKey}`, "x-project-scope": "vega" };
    const get = (path: string) => app!.inject({ method: "GET", url: `${path}${path.includes("?") ? "&" : "?"}org-id=spoofed&project-scope=vega`, headers });
    const snapshot = await get("/v1/memory/graph?limit=2");
    assert(snapshot.statusCode === 200 && snapshot.json().entities.length === 2 && snapshot.json().edges.length === 1, `${scope} snapshot shape: ${snapshot.body}`);
    assert(snapshot.json().entities.every((entity: { id: string }) => [item.file, item.fn].includes(entity.id)) && snapshot.json().edges[0].id === item.edge, `${scope} snapshot leaked another project or uncertain row`);
    const name = await get("/v1/memory/graph/search?q=verifyToken");
    assert(name.statusCode === 200 && name.json().matches.length === 1 && name.json().matches[0] === item.fn && name.json().edges[0]?.id === item.edge, `${scope} name search crossed project`);
    const semantic = await get("/v1/memory/graph/search?q=auth&mode=semantic");
    assert(semantic.statusCode === 200 && semantic.json().matches.length === 1 && semantic.json().matches[0] === item.file && semantic.json().edges[0]?.id === item.edge, `${scope} semantic search crossed project`);
    const files = await get("/v1/memory/graph/files?limit=1");
    assert(files.statusCode === 200 && files.json().files.length === 1 && files.json().files[0].id === item.file, `${scope} File page crossed project`);
    const dependencies = await get("/v1/memory/graph/dependencies?limit=1");
    assert(dependencies.statusCode === 200 && dependencies.json().edges.length === 1 && dependencies.json().edges[0].id === item.edge, `${scope} dependency page crossed project`);
    const related = await get("/v1/memory/graph/related-facts?file=src%2Fauth.ts");
    assert(related.statusCode === 200 && related.json().facts.length === 1 && related.json().facts[0].id === item.fact, `${scope} related fact crossed project`);
    if (scope !== "vega") {
      const foreignFile = await get("/v1/memory/graph/related-facts?file=src%2Fprivate.ts");
      assert(foreignFile.statusCode === 404, `${scope} resolved Vega-only File`);
    }
  }
  await app.close();
  app = buildProxy({ cors: false, rateLimit: false, memory: createSupabaseMemoryDeps(db, async () => vector) });
  const personal = await app.inject({ method: "GET", url: `/v1/memory/graph?org-id=${org}&limit=100` });
  assert(personal.statusCode === 200 && personal.json().entities.some((entity: { id: string }) => entity.id === uncertain), "personal mode lost historical organization graph rows");
  process.stdout.write("local project-scoped graph reads, provenance guards, and uncertain-row quarantine passed\n");
} catch (error) {
  failure = error;
} finally {
  try { await app?.close(); } catch (error) { if (!failure) failure = error; }
  try {
    for (const table of ["memory_vectors", "source_fact_links", "function_changes", "knowledge_edges", "knowledge_entities", "api_keys", "sessions"]) {
      checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`);
    }
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) { if (!failure) failure = error; }
}
if (failure) throw failure;
