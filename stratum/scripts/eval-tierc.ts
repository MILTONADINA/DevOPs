/** Offline Tier-C release gate: 50 authored critical queries, real cached encoder/pruner, no judge. */
import { join } from "node:path";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { DEFAULT_KADANEDIAL } from "../src/pruner/kadanedial";
import { loadTierCCorpus, runTierC } from "../evals/harness/tierc";

export async function main(): Promise<number> {
  try {
    const file = join(process.cwd(), "evals", "datasets", "golden", "tier-c.jsonl");
    const cases = loadTierCCorpus(file);
    const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
    const result = await runTierC(cases, encoder);
    process.stdout.write(
      `Tier-C critical golden queries: ${result.passed}/${result.total} passed; lambda=${DEFAULT_KADANEDIAL.lambda}, gainShift=${DEFAULT_KADANEDIAL.gainShift}, theta=${DEFAULT_KADANEDIAL.theta}\n`,
    );
    for (const entry of result.results) {
      if (entry.golden.passed) continue;
      process.stdout.write(`${entry.id}: missing [${entry.golden.missing.join(", ")}], leaked [${entry.golden.leaked.join(", ")}]\n`);
    }
    return result.failedIds.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Tier-C failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-tierc.ts") || entryPath.endsWith("eval-tierc.js")) {
  main().then((code) => {
    process.exitCode = code;
  });
}
