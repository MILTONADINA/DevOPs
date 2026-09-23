/** Real local text model -> source ingestor -> scoped PostgreSQL graph. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
const endpoint = process.env["CQ_LOCAL_BASE_URL"];
const model = process.env["CQ_SOURCE_SUMMARY_MODEL"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root || !endpoint || !model) {
  throw new Error("run through db:with-env from stratum/ with a real loopback source model");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const source = "stratum/test/fixtures/source-graph";
function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

let failure: unknown;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs real source summary check" }), "insert org");
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/ingest-source-graph.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, INGEST_ORG_ID: org, SOURCE_SUBDIR: source },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (child.error || child.status !== 0 || !child.stdout.includes("Indexed 2 source files, 4 entities, 3 edges")) {
    throw new Error(`real source ingest failed: ${child.error?.message ?? (child.stderr || child.stdout)}`);
  }
  const entities = checked(await db.from("knowledge_entities").select("id,kind,name,summary").eq("org_id", org), "read entities");
  const vectors = checked(await db.from("memory_vectors").select("source_ref,embedding").eq("org_id", org).eq("source_type", "entity"), "read vectors");
  const entry = entities.find((entity) => entity.kind === "File" && entity.name === `${source}/entry.ts`);
  const helper = entities.find((entity) => entity.kind === "File" && entity.name === `${source}/helper.ts`);
  const convert = entities.find((entity) => entity.kind === "Function" && entity.name === `${source}/entry.ts#convert`);
  if (
    entities.length !== 4 ||
    vectors.length !== 4 ||
    !entry?.summary ||
    !/convert|helper/i.test(entry.summary) ||
    entry.summary.startsWith("Source file ") ||
    !helper?.summary ||
    !/helper|unchanged/i.test(helper.summary) ||
    helper.summary.startsWith("Source file ") ||
    convert?.summary !== "Convert a sample value using the helper." ||
    vectors.some((vector) => !entities.some((entity) => entity.id === vector.source_ref) || typeof vector.embedding !== "string")
  ) {
    throw new Error("real model File summaries, Function summary, or embeddings did not persist");
  }
  process.stdout.write(`Real local model persisted 2 File summaries and 4 entity embeddings for disposable organization ${org.slice(0, 8)}…\n`);
} catch (error) {
  failure = error;
} finally {
  for (const table of ["knowledge_edges", "knowledge_entities"]) {
    try {
      checked(await db.from(table).delete().eq("org_id", org), `delete ${table}`);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  try {
    checked(await db.from("organizations").delete().eq("id", org), "delete org");
  } catch (error) {
    if (!failure) failure = error;
  }
}
if (failure) throw failure;
const remaining = checked(await db.from("organizations").select("id").eq("id", org), "verify org cleanup");
const remainingEntities = checked(await db.from("knowledge_entities").select("id").eq("org_id", org), "verify graph cleanup");
const remainingVectors = checked(await db.from("memory_vectors").select("id").eq("org_id", org), "verify vector cleanup");
if (remaining.length || remainingEntities.length || remainingVectors.length) throw new Error("real source fixture cleanup left organization, graph, or vector rows");
