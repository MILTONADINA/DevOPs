// Source fixture → local graph rows, idempotency, and root-boundary check.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const root = resolve(process.cwd(), "..");
const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_KEY"];
if (url !== "http://127.0.0.1:54321" || !key || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run through npm run db:with-env from stratum/");
}
const db = createClient(url, key, { auth: { persistSession: false } });
const org = randomUUID();
const source = "stratum/test/fixtures/source-graph";

function checked<T>(result: { data: T; error: { message: string } | null }, step: string): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}
function run(subdir: string): { status: number | null; stderr: string; stdout: string } {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/ingest-source-graph.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, INGEST_ORG_ID: org, SOURCE_SUBDIR: subdir },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  return child;
}

let failure: unknown;
let originalEmbedding: string | undefined;
try {
  checked(await db.from("organizations").insert({ id: org, name: "DevOPs source graph check" }), "insert org");
  const outside = run("../");
  if (outside.status === 0 || !outside.stderr.includes("outside the project")) throw new Error("outside-root source path was accepted");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(source);
    if (result.status !== 0 || !result.stdout.includes("Indexed 2 source files, 4 entities, 3 edges")) {
      throw new Error(`source ingest failed: ${result.stderr || result.stdout}`);
    }
    const entities = checked(await db.from("knowledge_entities").select("id,kind,name,file_path,summary").eq("org_id", org), "read entities");
    const edges = checked(await db.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", org), "read edges");
    const vectors = checked(await db.from("memory_vectors").select("source_ref,embedding").eq("org_id", org).eq("source_type", "entity"), "read entity vectors");
    const entry = entities.find((row) => row.name === `${source}/entry.ts#convert`);
    if (
      entities.length !== 4 ||
      vectors.length !== 4 ||
      vectors.some((row) => !entities.some((entity) => entity.id === row.source_ref)) ||
      edges.length !== 3 ||
      entry?.file_path !== `${source}/entry.ts` ||
      entry?.summary !== "Convert a sample value using the helper." ||
      edges.filter((edge) => edge.edge_type === "DECLARES").length !== 2 ||
      edges.filter((edge) => edge.edge_type === "DEPENDS_ON").length !== 1
    ) {
      throw new Error("source graph rows or idempotency did not match fixture");
    }
    const entryVector = vectors.find((row) => row.source_ref === entry.id)?.embedding;
    if (typeof entryVector !== "string") throw new Error("source graph entity embedding is missing");
    if (attempt === 0) {
      originalEmbedding = entryVector;
      checked(
        await db
          .from("memory_vectors")
          .update({ embedding: Array(384).fill(0) })
          .eq("org_id", org)
          .eq("source_type", "entity")
          .eq("source_ref", entry.id),
        "corrupt vector for replacement check",
      );
    } else if (entryVector !== originalEmbedding) {
      throw new Error("reingestion did not replace the entity embedding");
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run("stratum/test/fixtures/source-graph-rust");
    if (result.status !== 0 || !result.stdout.includes("Indexed 2 source files, 4 entities, 3 edges")) {
      throw new Error(`Rust source ingest failed: ${result.stderr || result.stdout}`);
    }
    const entities = checked(await db.from("knowledge_entities").select("id,name").eq("org_id", org), "read Rust entities");
    const edges = checked(await db.from("knowledge_edges").select("id").eq("org_id", org), "read Rust edges");
    const vectors = checked(await db.from("memory_vectors").select("id").eq("org_id", org).eq("source_type", "entity"), "read Rust vectors");
    if (entities.length !== 8 || edges.length !== 6 || vectors.length !== 8 || !entities.some((row) => row.name === "stratum/test/fixtures/source-graph-rust/src/lib.rs#entry")) {
      throw new Error(`Rust graph rows duplicated or missing after ingest ${attempt + 1}`);
    }
  }
  process.stdout.write("local JS/TS and Rust source graph fixtures persisted and remained idempotent\n");
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
