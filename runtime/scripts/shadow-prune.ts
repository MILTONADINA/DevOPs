/**
 * Shadow-mode pruning MEASUREMENT (Phase 1 — does NOT enable pruning anywhere).
 *
 * Runs the verified KadaneDial pruner over the imported corpus to estimate how
 * much prior-turn history it WOULD drop at real query points, using the real
 * ONNX encoder. This is observation only: nothing here touches the proxy request
 * path (pruning stays shadow-mode until the published Tier-A eval passes).
 *
 * HONEST CAVEATS:
 *  - The imported corpus stores each turn's USER content (the new input), not the
 *    full accumulated context the live proxy sees. So this measures
 *    relevance-pruning over the user-turn HISTORY — a directional value-prop
 *    signal, not the exact request-path token reduction.
 *  - Per-turn weight is a chars/4 ESTIMATE of that turn's marginal content (the
 *    artifact's token_counts.input_tokens is the cumulative cache-inclusive
 *    context size at that turn, not the marginal turn size, so it's the wrong
 *    weight here). Directional, not billable.
 *
 *   npm run shadow-prune
 */

import { join } from "node:path";
import { readSessionsFromDir } from "../src/proxy/routes/dashboard";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL } from "../src/pruner/kadanedial";

const MAX_TURNS = 300; // cap per session to bound the encode cost
const FIRST_QUERY = 15; // need some history before a query point is meaningful
const STRIDE = 20; // sample a query point every STRIDE turns

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const r = b as Record<string, unknown>;
        return typeof r["text"] === "string" ? (r["text"] as string) : JSON.stringify(b);
      })
      .join(" ");
  }
  return content == null ? "" : JSON.stringify(content);
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const dir = join(process.cwd(), "data", "sessions");
  const sessions = readSessionsFromDir(dir);
  if (sessions.length === 0) {
    out(`No corpus in ${dir}. Run \`npm run import-sessions\` or \`npm run dev\` first.`);
    return 0;
  }

  out("Shadow-mode pruning measurement (Phase 1 — NOT wired into the request path)");
  out("=".repeat(70));
  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });

  const allTurnReductions: number[] = [];
  const allContentReductions: number[] = [];

  for (const s of sessions) {
    const turns = s.requests.slice(0, MAX_TURNS);
    if (turns.length < FIRST_QUERY + STRIDE) {
      out(`  ${s.session_id.slice(0, 20)}: too short (${turns.length} turns) — skipped`);
      continue;
    }
    const texts = turns.map((t) => textOf(t.request.messages));
    const weights = texts.map(estTokens);
    const timesSec = turns.map((t) => (typeof t.timestamp === "number" ? t.timestamp / 1000 : 0));
    const vecs = await encoder.encode(texts); // encoder micro-batches internally

    const turnReductions: number[] = [];
    const contentReductions: number[] = [];
    for (let q = FIRST_QUERY; q < turns.length; q += STRIDE) {
      const queryVec = vecs[q];
      if (!queryVec) continue;
      const history: HistoryEmbedding[] = [];
      for (let i = 0; i < q; i++) history.push({ embedding: vecs[i]!, timestampSeconds: timesSec[i] ?? 0 });
      const decision = prune(queryVec, history, { ...DEFAULT_KADANEDIAL, nowSeconds: timesSec[q] ?? 0 });

      const histWeight = weights.slice(0, q).reduce((a, b) => a + b, 0);
      const keptWeight = decision.selectedIndices.reduce((a, i) => a + (weights[i] ?? 0), 0);
      turnReductions.push((q - decision.selectedIndices.length) / q);
      contentReductions.push(histWeight > 0 ? (histWeight - keptWeight) / histWeight : 0);
    }
    allTurnReductions.push(...turnReductions);
    allContentReductions.push(...contentReductions);
    out(
      `  ${s.session_id.slice(0, 20)}: ${turns.length} turns, ${turnReductions.length} query points — ` +
        `median history-turn drop ${(median(turnReductions) * 100).toFixed(0)}%, content drop ${(median(contentReductions) * 100).toFixed(0)}%`,
    );
  }

  out("");
  out(`Across ${allTurnReductions.length} query points over ${sessions.length} session(s):`);
  out(`  median history-TURN reduction:    ${(median(allTurnReductions) * 100).toFixed(0)}%`);
  out(`  median history-CONTENT reduction: ${(median(allContentReductions) * 100).toFixed(0)}% (chars/4 estimate)`);
  out("");
  out("DIRECTIONAL only: measures relevance-pruning over the user-turn history of");
  out("the imported corpus, not the full live-proxy context. Pruning is NOT enabled");
  out("in the request path (shadow-mode until the published Tier-A eval passes).");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("shadow-prune.ts") || entryPath.endsWith("shadow-prune.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
