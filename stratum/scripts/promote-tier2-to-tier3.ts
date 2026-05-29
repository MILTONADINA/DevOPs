/**
 * Nightly Promotion Job — Tier 2 → Tier 3.
 *
 * Promotes structured Tier-2 facts into the Tier-3 knowledge graph (+ vectors).
 *
 * CORE LOGIC IS IMPLEMENTED + UNIT-TESTED:
 *   - facts → graph entities/edges: src/memory/promote.ts (promoteFactsToGraph /
 *     factToGraphOps) — test/memory/promote.test.ts.
 *   - graph adapter: src/memory/cold/graph.ts (createKnowledgeGraph).
 *   - vector adapter: src/memory/cold/vectors.ts (createVectorStore).
 * Tier-3 runs on Supabase (ADR-0013); swap to Neo4j/Pinecone behind the same
 * interfaces later.
 *
 * REMAINING (gated on live data + a real embedding model):
 *   1. A warm-tier query for facts with promoted_to_t3 = false AND created_at < now-30d
 *      (needs a new WarmMemory method; today queryRecent reads recent facts).
 *   2. Encode each fact's text to a 384-d embedding (the ONNX encoder) → VectorStore.upsert.
 *   3. promoteFactsToGraph(graph, facts, {orgId}) for the graph half.
 *   4. Mark the Supabase rows promoted_to_t3 = true (never delete).
 *   5. Log the run.
 * This orchestration needs SUPABASE_SERVICE_KEY + a populated DB to run/verify, so it
 * is intentionally NOT stubbed with un-runnable scaffolding here — it is wired when a
 * live fact corpus exists (the same gating as scripts/verify-tier2.ts).
 *
 * Usage: npm run promote
 */

import "dotenv/config";

export function main(): number {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const hasCreds = !!process.env["SUPABASE_URL"] && !!process.env["SUPABASE_SERVICE_KEY"];
  out("Tier-2 → Tier-3 promotion");
  out("  core logic: src/memory/promote.ts (implemented + tested)");
  out(
    hasCreds
      ? "  creds present — the full nightly orchestration (>30d fact query + encode + upsert + mark-promoted) is pending a populated fact corpus; see this file's header."
      : "  SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — the live promotion run is gated on credentials + a populated fact corpus.",
  );
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("promote-tier2-to-tier3.ts") || entryPath.endsWith("promote-tier2-to-tier3.js")) {
  process.exitCode = main();
}
