/** Project-bound JS/TS source files → Tier-3 File/Function dependency graph. */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createKnowledgeGraph } from "../src/memory/cold/graph";
import { indexSourceFiles, type SourceFileInput } from "../src/memory/source-graph";
import { graphEncoder, graphEntityText } from "../src/memory/graph-embedding";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "data", "models", "backups", "target"]);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|rs|py)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectFiles(root: string, dir: string): SourceFileInput[] {
  const files: SourceFileInput[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && statSync(path).size <= 512 * 1024) {
        files.push({ path: relative(root, path).split(sep).join("/"), source: readFileSync(path, "utf8") });
      }
    }
  };
  walk(dir);
  return files;
}

function sourceDirectory(root: string, subtree: string): string {
  if (isAbsolute(subtree)) throw new Error("SOURCE_SUBDIR must be project-relative");
  const candidate = resolve(root, subtree);
  if (candidate !== root && !candidate.startsWith(root + sep)) throw new Error("SOURCE_SUBDIR is outside the project");
  if (realpathSync(candidate) !== candidate) throw new Error("SOURCE_SUBDIR contains a symbolic link");
  if (!lstatSync(candidate).isDirectory()) throw new Error("SOURCE_SUBDIR must be a directory");
  return candidate;
}

export async function main(): Promise<void> {
  const root = realpathSync(resolve(process.cwd(), ".."));
  if (realpathSync(process.cwd()) !== join(root, "stratum") || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
    throw new Error("run from stratum/ through db:with-env with the trusted project root");
  }
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  const orgId = process.env["INGEST_ORG_ID"];
  if (url !== "http://127.0.0.1:54321" || !key || !orgId || !UUID.test(orgId)) {
    throw new Error("local Compose URL, service key, and UUID INGEST_ORG_ID are required");
  }
  const dir = sourceDirectory(root, process.env["SOURCE_SUBDIR"] ?? "stratum/src");
  const files = collectFiles(root, dir);
  const graph = indexSourceFiles(files);
  const client = createClient(url, key, { auth: { persistSession: false } });
  const org = await client.from("organizations").select("id").eq("id", orgId).single();
  if (org.error || !org.data) throw new Error("INGEST_ORG_ID does not exist in the local database");
  const encoder = await graphEncoder();
  const embeddings: Float32Array[] = [];
  for (let offset = 0; offset < graph.entities.length; offset += 16) {
    embeddings.push(...(await encoder.encode(graph.entities.slice(offset, offset + 16).map(graphEntityText))));
  }
  const store = createKnowledgeGraph(client);
  const ids = new Map<string, string>();
  for (const entity of graph.entities) {
    ids.set(entity.name, await store.ensureEntity({ orgId, kind: entity.kind, name: entity.name, filePath: entity.filePath, summary: entity.summary }));
  }
  for (let offset = 0; offset < graph.entities.length; offset += 16) {
    const batch = graph.entities.slice(offset, offset + 16);
    const rows = batch.map((entity, index) => ({
      org_id: orgId,
      source_type: "entity",
      source_ref: ids.get(entity.name)!,
      embedding: Array.from(embeddings[offset + index]!),
    }));
    const result = await client.from("memory_vectors").upsert(rows, { onConflict: "org_id,source_type,source_ref" });
    if (result.error) throw new Error(`graph vector upsert failed: ${result.error.message}`);
  }
  for (const edge of graph.edges) {
    const fromEntity = ids.get(edge.fromName);
    const toEntity = ids.get(edge.toName);
    if (!fromEntity || !toEntity) throw new Error("source graph edge has a missing endpoint");
    await store.addEdge({ orgId, fromEntity, toEntity, edgeType: edge.edgeType });
  }
  process.stdout.write(`Indexed ${files.length} source files, ${graph.entities.length} entities, ${graph.edges.length} edges for org ${orgId.slice(0, 8)}…\n`);
}

if ((process.argv[1] ?? "").endsWith("ingest-source-graph.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`source graph ingestion failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
