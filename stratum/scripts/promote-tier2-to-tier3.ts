/**
 * Nightly Promotion Job — Tier 2 → Tier 3.
 *
 * Promotes structured Tier-2 facts (older than a cutoff, not yet promoted) into the
 * Tier-3 knowledge graph + vector store, then marks them promoted. Closes the
 * hot→warm→COLD loop's automation. FREE: encodes each fact's text with the LOCAL
 * ONNX encoder (no Anthropic; promotion embeds EXISTING structured facts, it does
 * not extract). Tier-3 is on Supabase (ADR-0013); swap to Neo4j/Pinecone behind the
 * same interfaces later.
 *
 *   npm run promote
 *
 * Config (env):
 *   PROMOTE_OLDER_THAN_DAYS   only promote facts older than this many days (default 30;
 *                             set 0 to promote ALL unpromoted facts — e.g. for verification)
 *   PROMOTE_LIMIT             max facts per org per table (default 500)
 *   PROMOTE_ORG_ID            promote only this org (default: all organizations)
 *
 * GATED on SUPABASE_URL + SUPABASE_SERVICE_KEY (skips cleanly without them). Each
 * fact is marked `promoted_to_t3 = true` (never deleted) so re-runs are idempotent.
 */

import "dotenv/config";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createWarmMemory } from "../src/memory/warm/tier2";
import { createKnowledgeGraph } from "../src/memory/cold/graph";
import { createVectorStore } from "../src/memory/cold/vectors";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { promoteFacts } from "../src/memory/promote";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("Tier-2 → Tier-3 promotion — SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY not set.");
    return 0;
  }

  const olderThanDays = envInt("PROMOTE_OLDER_THAN_DAYS", 30);
  const limit = envInt("PROMOTE_LIMIT", 500);
  const olderThanIso = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const onlyOrg = process.env["PROMOTE_ORG_ID"];

  const client = createClient(url, key);
  const warm = createWarmMemory(client);
  const graph = createKnowledgeGraph(client);
  const vectors = createVectorStore(client);
  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });

  out("Tier-2 → Tier-3 promotion (offline encoder; no Anthropic API)");
  out("=".repeat(60));
  out(`  cutoff: facts created before ${olderThanIso} (older than ${olderThanDays}d); limit ${limit}/table/org`);

  // Resolve target orgs.
  let orgIds: string[];
  if (onlyOrg) {
    orgIds = [onlyOrg];
  } else {
    const res = await client.from("organizations").select("id");
    if (res.error) {
      out(`  org lookup failed: ${res.error.message}`);
      return 1;
    }
    orgIds = ((res.data ?? []) as { id: string }[]).map((r) => r.id);
  }
  out(`  organizations to scan: ${orgIds.length}`);

  let totalFacts = 0;
  let totalEntities = 0;
  let totalEdges = 0;
  let totalVectors = 0;
  let totalMarked = 0;
  for (const orgId of orgIds) {
    const facts = await warm.queryUnpromoted(orgId, { olderThanIso, limit });
    if (facts.length === 0) continue;
    const promo = await promoteFacts({ graph, vectors, encoder }, facts, { orgId });
    const marked = await warm.markPromoted(facts, orgId);
    totalFacts += facts.length;
    totalEntities += promo.entities;
    totalEdges += promo.edges;
    totalVectors += promo.vectors;
    totalMarked += marked;
    out(`  ${orgId.slice(0, 8)}…  ${facts.length} fact(s) → ${promo.entities} entities, ${promo.edges} edges, ${promo.vectors} vectors; marked ${marked} promoted`);
  }

  out("");
  out(`Done. Promoted ${totalFacts} fact(s) across ${orgIds.length} org(s): ${totalEntities} entities, ${totalEdges} edges, ${totalVectors} vectors; ${totalMarked} marked promoted_to_t3.`);
  if (totalFacts > 0 && totalMarked !== totalFacts) {
    out(`WARNING: marked (${totalMarked}) != promoted (${totalFacts}) — investigate before the next run.`);
    return 1;
  }
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("promote-tier2-to-tier3.ts") || entryPath.endsWith("promote-tier2-to-tier3.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`promote failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
