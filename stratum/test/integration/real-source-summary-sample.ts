/** Bounded real local-model quality sample; no database writes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexSourceFiles, type SourceFileInput } from "../../src/memory/source-graph";
import { createLocalSourceCompletion, summarizeSourceFiles } from "../../src/memory/source-summary";

const root = resolve(process.cwd(), "..");
if (process.cwd() !== resolve(root, "stratum") || process.env["DEVOPS_STRATUM_PROJECT_ROOT"] !== root) {
  throw new Error("run from stratum/ with DEVOPS_STRATUM_PROJECT_ROOT set to the project root");
}
const endpoint = process.env["CQ_LOCAL_BASE_URL"];
const model = process.env["CQ_SOURCE_SUMMARY_MODEL"];
if (!endpoint || !model) throw new Error("CQ_LOCAL_BASE_URL and CQ_SOURCE_SUMMARY_MODEL are required");

const samples: [string, RegExp][] = [
  ["stratum/rust/hot-path/src/lib.rs", /sha.?256|hash/i],
  ["stratum/src/audit/git-attestation.ts", /git|commit/i],
  ["stratum/src/billing/calculator.ts", /fee|billing/i],
  ["stratum/src/memory/graph-embedding.ts", /embedding|encoder/i],
  ["stratum/src/memory/source-summary.ts", /summar/i],
  ["stratum/src/proxy/auth.ts", /key|auth/i],
  ["stratum/src/proxy/message-memory.ts", /fact|memory/i],
  ["stratum/test/fixtures/source-graph-rust/src/lib.rs", /entry|helper/i],
  ["stratum/test/fixtures/source-graph/entry.ts", /convert|helper/i],
  ["stratum/test/fixtures/source-graph/helper.ts", /helper|unchanged/i],
  ["tests/fixtures/agents/asi01-failing/harness.py", /vulnerable|hijack|asi01/i],
];
const files: SourceFileInput[] = samples.map(([path]) => ({ path, source: readFileSync(resolve(root, path), "utf8") }));
const start = Date.now();
const graph = await summarizeSourceFiles(files, indexSourceFiles(files), createLocalSourceCompletion(endpoint, model, process.env["CQ_LOCAL_API_KEY"]));
const summaries = graph.entities.filter((entity) => entity.kind === "File");
if (summaries.length !== samples.length) throw new Error(`expected ${samples.length} File summaries, got ${summaries.length}`);
for (const [path, subject] of samples) {
  const summary = summaries.find((entity) => entity.name === path)?.summary;
  if (!summary || !subject.test(summary) || !/[.!?]$/.test(summary)) throw new Error(`real model summary missed its subject or sentence boundary: ${path}: ${summary ?? "missing"}`);
  process.stdout.write(`${path}: ${summary}\n`);
}
process.stdout.write(`Real local model summarized ${samples.length} JS/TS, Rust, and Python Files in ${Date.now() - start}ms without database writes\n`);
