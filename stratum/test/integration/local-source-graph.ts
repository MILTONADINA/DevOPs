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
    const entry = entities.find((row) => row.name === `${source}/entry.ts#convert`);
    if (
      entities.length !== 4 ||
      edges.length !== 3 ||
      entry?.file_path !== `${source}/entry.ts` ||
      entry?.summary !== "Convert a sample value using the helper." ||
      edges.filter((edge) => edge.edge_type === "DECLARES").length !== 2 ||
      edges.filter((edge) => edge.edge_type === "DEPENDS_ON").length !== 1
    ) {
      throw new Error("source graph rows or idempotency did not match fixture");
    }
  }
  process.stdout.write("local source graph fixture persisted and remained idempotent\n");
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
