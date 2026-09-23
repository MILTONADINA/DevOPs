/** Local v0.6 gate: index the latest 100 real commits in under 5s p95. */
import { performance } from "node:perf_hooks";
import { defaultRunGit, indexRepository } from "../src/audit/git-indexer";

const COMMITS = 100;
const SAMPLES = 5;
const TARGET_MS = 5_000;

export async function main(): Promise<number> {
  const cwd = process.cwd();
  const historyCount = Number((await defaultRunGit(["rev-list", "--count", "HEAD"], cwd)).trim());
  if (!Number.isInteger(historyCount) || historyCount < COMMITS) {
    process.stdout.write(`BLOCKED: need at least ${COMMITS} commits; checkout has ${historyCount}.\n`);
    return 2;
  }

  const times: number[] = [];
  let changeCount = -1;
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    const changes = await indexRepository({ cwd, maxCount: COMMITS });
    times.push(performance.now() - start);
    if (changeCount >= 0 && changes.length !== changeCount) {
      throw new Error("indexer change count varied across unchanged-history samples");
    }
    changeCount = changes.length;
  }
  if (changeCount === 0) {
    process.stdout.write("FAIL: indexer returned no declaration changes.\n");
    return 1;
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(SAMPLES * 0.95) - 1]!;
  const passed = p95 < TARGET_MS;
  process.stdout.write(JSON.stringify({ scope: "local checkout", commitsIndexed: COMMITS, declarationChanges: changeCount, sampleMs: times.map((t) => Number(t.toFixed(2))), p95Ms: Number(p95.toFixed(2)), targetMs: TARGET_MS, passed }) + "\n");
  return passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("bench-audit-indexer.ts") || entryPath.endsWith("bench-audit-indexer.js")) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`audit indexer benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
