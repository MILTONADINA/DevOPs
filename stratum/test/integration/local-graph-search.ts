// A node older than the 500-node snapshot is still found within the key's org.
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
const own = randomUUID();
const foreign = randomUUID();
const raw = `cq_test_${randomUUID()}`;
const needle = randomUUID();
const neighbor = randomUUID();
const typo = randomUUID();
const foreignNeedle = randomUUID();
const foreignOther = randomUUID();

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let app: ReturnType<typeof buildProxy> | undefined;
let failure: unknown;
try {
  checked(
    await db.from("organizations").insert([
      { id: own, name: "Graph search A" },
      { id: foreign, name: "Graph search B" },
    ]),
    "insert orgs",
  );
  checked(await db.from("api_keys").insert({ org_id: own, key_hash: hashApiKey(raw), name: "graph-search" }), "insert key");
  const filler = Array.from({ length: 500 }, (_, i) => ({
    id: i === 0 ? neighbor : i === 1 ? typo : randomUUID(),
    org_id: own,
    kind: "File",
    name: i === 1 ? "src/needel-handler.ts" : `src/filler-${i}.ts`,
    created_at: "2026-09-23T00:00:00Z",
  }));
  checked(
    await db
      .from("knowledge_entities")
      .insert([
        { id: needle, org_id: own, kind: "File", name: "src/needle-handler.ts", file_path: "src/needle-handler.ts", summary: "Needle handler", created_at: "2020-01-01T00:00:00Z" },
        ...filler,
        { id: foreignNeedle, org_id: foreign, kind: "File", name: "src/needle-handler.ts", created_at: "2020-01-01T00:00:00Z" },
        { id: foreignOther, org_id: foreign, kind: "File", name: "src/foreign-other.ts", created_at: "2020-01-01T00:00:00Z" },
      ]),
    "insert graph nodes",
  );
  const fixtureEdges = filler.map((node, i) => ({
    org_id: own,
    from_entity: i < 250 ? needle : node.id,
    to_entity: i < 250 ? node.id : needle,
    edge_type: "DEPENDS_ON",
  }));
  checked(await db.from("knowledge_edges").insert([...fixtureEdges, { org_id: foreign, from_entity: foreignNeedle, to_entity: foreignOther, edge_type: "DEPENDS_ON" }]), "insert edges");
  app = buildProxy(
    buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }, { cors: false, rateLimit: false }, (clientUrl, clientKey) =>
      createClient(clientUrl, clientKey, { auth: { persistSession: false } }),
    ),
  );
  const get = (path: string) => app!.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${raw}` } });
  const snapshot = await get("/v1/memory/graph?limit=500");
  if (snapshot.statusCode !== 200 || snapshot.json().entities.length !== 500 || snapshot.json().entities.some((node: { id: string }) => node.id === needle)) {
    throw new Error("needle was not outside the 500-node snapshot");
  }
  const response = await get(`/v1/memory/graph/search?org-id=${foreign}&q=needle`);
  const graph = response.json();
  if (
    response.statusCode !== 200 ||
    graph.matches?.[0] !== needle ||
    graph.entities.length > 220 ||
    graph.edges.length < 150 ||
    graph.edges.length > 200 ||
    !graph.entities.some((node: { id: string }) => node.id !== needle && node.id !== typo) ||
    graph.entities.some((node: { id: string }) => node.id === foreignNeedle) ||
    !graph.edges.every(
      (edge: { from_entity: string; to_entity: string }) =>
        graph.entities.some((node: { id: string }) => node.id === edge.from_entity) && graph.entities.some((node: { id: string }) => node.id === edge.to_entity),
    )
  ) {
    throw new Error(`scoped fuzzy search failed: status=${response.statusCode}, matches=${graph.matches?.length}, nodes=${graph.entities?.length}, edges=${graph.edges?.length}`);
  }
  const misspelled = await get("/v1/memory/graph/search?q=needel");
  const ranked = misspelled.json();
  if (misspelled.statusCode !== 200 || ranked.matches?.[0] !== typo || !ranked.matches.includes(needle)) {
    throw new Error(`fuzzy typo search failed: ${misspelled.payload}`);
  }
  const files: string[] = [];
  let fileAfter: string | null = null;
  for (let page = 0; page < 10; page++) {
    const response = await get(`/v1/memory/graph/files?org-id=${foreign}&limit=200${fileAfter ? `&after=${encodeURIComponent(fileAfter)}` : ""}`);
    if (response.statusCode !== 200) throw new Error(`file page failed: ${response.statusCode}`);
    const body = response.json();
    files.push(...body.files.map((item: { id: string }) => item.id));
    fileAfter = body.next;
    if (!fileAfter) break;
  }
  if (files.length !== 501 || new Set(files).size !== 501 || !files.includes(needle) || files.includes(foreignNeedle) || files.includes(foreignOther)) {
    throw new Error(`file pagination missed or leaked rows: ${files.length}`);
  }
  const dependencies: string[] = [];
  let edgeAfter: string | null = null;
  for (let page = 0; page < 10; page++) {
    const response = await get(`/v1/memory/graph/dependencies?org-id=${foreign}&limit=200${edgeAfter ? `&after=${edgeAfter}` : ""}`);
    if (response.statusCode !== 200) throw new Error(`dependency page failed: ${response.statusCode}`);
    const body = response.json();
    dependencies.push(...body.edges.map((item: { id: string }) => item.id));
    edgeAfter = body.next;
    if (!edgeAfter) break;
  }
  if (dependencies.length !== 500 || new Set(dependencies).size !== 500) {
    throw new Error(`dependency pagination missed or leaked rows: ${dependencies.length}`);
  }
  process.stdout.write("local fuzzy search and 501-file/500-edge traversal stayed organization-scoped\n");
} catch (error) {
  failure = error;
} finally {
  try {
    await app?.close();
  } catch (error) {
    if (!failure) failure = error;
  }
  for (const table of ["knowledge_edges", "knowledge_entities", "api_keys"]) {
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
