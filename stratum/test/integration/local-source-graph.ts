// Source fixture → local graph rows, idempotency, and root-boundary check.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
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
function run(subdir: string, extraEnv: Record<string, string> = {}): { status: number | null; stderr: string; stdout: string } {
  const child = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("scripts/ingest-source-graph.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, INGEST_ORG_ID: org, SOURCE_SUBDIR: subdir, CQ_SOURCE_SUMMARY_MODEL: "", CQ_LOCAL_BASE_URL: "http://127.0.0.1:1/v1", ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  return child;
}
async function runWithModel(subdir: string, port: number): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(resolve("node_modules/.bin/tsx"), [resolve("scripts/ingest-source-graph.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, INGEST_ORG_ID: org, SOURCE_SUBDIR: subdir, CQ_SOURCE_SUMMARY_MODEL: "local/check", CQ_LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, CQ_LOCAL_API_KEY: "" },
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const status = await new Promise<number | null>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", resolveDone);
    });
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

let failure: unknown;
let originalEmbedding: string | undefined;
let summaryCalls = 0;
let rejectSecondSummary = false;
const model = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body) as { model?: string; messages?: { content?: string }[] };
  if (request.url !== "/v1/chat/completions" || request.method !== "POST" || payload.model !== "check" || !payload.messages?.[1]?.content?.includes('untrusted="true"')) {
    response.writeHead(400).end();
    return;
  }
  summaryCalls++;
  const name = payload.messages[1].content.includes("Path: stratum/test/fixtures/source-graph/entry.ts") ? "entry" : "helper";
  const content = rejectSecondSummary && name === "helper" ? "<script>unsafe</script>" : `Generated summary for ${name}.`;
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }] }));
});
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run("tests/fixtures/agents/asi01-failing");
    if (result.status !== 0 || !result.stdout.includes("Indexed 2 source files, 3 entities, 2 edges")) {
      throw new Error(`Python source ingest failed: ${result.stderr || result.stdout}`);
    }
    const entities = checked(await db.from("knowledge_entities").select("id,name").eq("org_id", org), "read Python entities");
    const edges = checked(await db.from("knowledge_edges").select("id").eq("org_id", org), "read Python edges");
    const vectors = checked(await db.from("memory_vectors").select("id").eq("org_id", org).eq("source_type", "entity"), "read Python vectors");
    if (entities.length !== 11 || edges.length !== 8 || vectors.length !== 11 || !entities.some((row) => row.name === "tests/fixtures/agents/asi01-failing/harness.py#model_callback")) {
      throw new Error(`Python graph rows duplicated or missing after ingest ${attempt + 1}`);
    }
  }
  const sourceFile = `${source}/entry.ts`;
  const fileRow = checked(await db.from("knowledge_entities").select("id,summary").eq("org_id", org).eq("kind", "File").eq("name", sourceFile).single(), "read source File before model");
  const beforeVector = checked(
    await db.from("memory_vectors").select("embedding").eq("org_id", org).eq("source_type", "entity").eq("source_ref", fileRow.id).single(),
    "read source File vector before model",
  );
  await new Promise<void>((resolveListen, reject) => {
    model.once("error", reject);
    model.listen(0, "127.0.0.1", resolveListen);
  });
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("local source model fixture did not bind");
  const generated = await runWithModel(source, address.port);
  if (generated.status !== 0 || summaryCalls !== 2) throw new Error(`local summary ingestion failed: ${generated.stderr || generated.stdout}`);
  const afterFile = checked(await db.from("knowledge_entities").select("summary").eq("org_id", org).eq("id", fileRow.id).single(), "read generated File summary");
  const afterFunction = checked(
    await db.from("knowledge_entities").select("summary").eq("org_id", org).eq("kind", "Function").eq("name", `${source}/entry.ts#convert`).single(),
    "read source Function summary",
  );
  const afterVector = checked(await db.from("memory_vectors").select("embedding").eq("org_id", org).eq("source_type", "entity").eq("source_ref", fileRow.id).single(), "read generated File vector");
  if (afterFile.summary !== "Generated summary for entry." || afterFunction.summary !== "Convert a sample value using the helper." || afterVector.embedding === beforeVector.embedding) {
    throw new Error("generated File summary or refreshed embedding was not persisted");
  }
  rejectSecondSummary = true;
  const refused = await runWithModel(source, address.port);
  const unchangedFile = checked(await db.from("knowledge_entities").select("summary").eq("org_id", org).eq("id", fileRow.id).single(), "read File after rejected summary");
  const unchangedVector = checked(
    await db.from("memory_vectors").select("embedding").eq("org_id", org).eq("source_type", "entity").eq("source_ref", fileRow.id).single(),
    "read vector after rejected summary",
  );
  if (
    refused.status === 0 ||
    !refused.stderr.includes("local source summary is empty, oversized, or unsafe") ||
    unchangedFile.summary !== afterFile.summary ||
    unchangedVector.embedding !== afterVector.embedding
  ) {
    throw new Error("rejected source summary changed a graph row or vector");
  }
  const missingEndpoint = run(source, { CQ_SOURCE_SUMMARY_MODEL: "local/check", CQ_LOCAL_BASE_URL: "" });
  if (missingEndpoint.status === 0 || !missingEndpoint.stderr.includes("CQ_LOCAL_BASE_URL is required") || summaryCalls !== 4) {
    throw new Error("source summary model accepted a missing endpoint or made a request");
  }
  process.stdout.write("local JS/TS, Rust, and Python graph ingestion plus loopback File summary persistence passed\n");
} catch (error) {
  failure = error;
} finally {
  if (model.listening) await new Promise<void>((resolveClose) => model.close(() => resolveClose()));
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
