/**
 * Tier-latency benchmark (v0.5.x ship-gate: "tier latencies met").
 *
 * Measures p50/p95/p99 of each memory tier + the pruner against the documented
 * targets (docs/MONITORING.md + docs/GLOSSARY.md):
 *   Tier-1 hot recall (RAM)        sub-ms              (GLOSSARY)
 *   Pruner (ONNX encode + KadaneDial)  p99 < 20ms      (MONITORING pruning.latency_ms)
 *   Tier-2 warm fact query         p95 < 80ms          (MONITORING memory.tier2_latency_ms)
 *   Tier-3 vector search           p95 < 200ms         (MONITORING memory.tier3_*_latency_ms)
 *   Tier-3 graph status query      p95 < 200ms         (no explicit target; vector-class)
 *
 *   npm run bench:tiers
 *
 * Tier-1 + pruner are LOCAL (always run; the pruner warms the ONNX model first —
 * first run downloads ~23MB to the gitignored models/). Tier-2/3 need
 * SUPABASE_URL + SUPABASE_SERVICE_KEY (skip cleanly without them); they seed a
 * throwaway org, measure, and delete it. NO Anthropic API.
 */

import "dotenv/config";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createHotMemory, type HotTurn } from "../src/memory/hot/tier1";
import { createOnnxEncoder, EMBEDDING_DIM } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL } from "../src/pruner/kadanedial";
import { createWarmMemory } from "../src/memory/warm/tier2";
import { createSessionStore } from "../src/memory/warm/sessions";
import { createKnowledgeGraph } from "../src/memory/cold/graph";
import { createVectorStore } from "../src/memory/cold/vectors";
import { summarize, type LatencySummary } from "../src/lib/latency-stats";

interface Target {
  metric: "p95" | "p99";
  maxMs: number;
}
interface Row {
  label: string;
  summary: LatencySummary;
  target: Target;
  passed: boolean;
}

function gate(summary: LatencySummary, target: Target): boolean {
  return summary[target.metric] < target.maxMs;
}

async function benchAsync(iters: number, fn: () => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function benchSync(iters: number, fn: () => void): number[] {
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function randomUnitVector(): number[] {
  const v = new Array<number>(EMBEDDING_DIM);
  let sumSq = 0;
  // Deterministic-ish spread without RNG (Math.random is fine in a script, but a
  // simple varying fill keeps the benchmark reproducible run-to-run).
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const x = Math.sin(i * 0.37 + 1);
    v[i] = x;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const rows: Row[] = [];

  out("Tier-latency benchmark (v0.5.x — targets per docs/MONITORING.md + GLOSSARY.md)");
  out("=".repeat(76));

  // ── Tier-1 hot recall (RAM) — always ──────────────────────────────────────
  {
    const hot = createHotMemory({ windowMs: 7_200_000, now: () => 1_700_000_000_000 });
    for (let i = 0; i < 300; i++) hot.add({ timestamp: 1_700_000_000_000 - i * 1000, role: "user", content: `turn ${i}` } as HotTurn);
    const samples = benchSync(3000, () => {
      hot.recent();
    });
    const summary = summarize(samples);
    const target: Target = { metric: "p95", maxMs: 1 };
    rows.push({ label: "Tier-1 hot recall (RAM, 300-turn window)", summary, target, passed: gate(summary, target) });
  }

  // ── Pruner: ONNX encode + KadaneDial — always (warms the model first) ──────
  {
    out("→ warming the ONNX model (first run downloads ~23MB to models/)…");
    const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
    const [warm] = await encoder.encode(["warm up the model"]);
    if (!warm) throw new Error("encoder failed to warm up");

    const encSamples = await benchAsync(50, async () => {
      await encoder.encode(["where are we deploying the auth service this quarter?"]);
    });
    const encSummary = summarize(encSamples);
    rows.push({ label: "Pruner: ONNX encode (1 query)", summary: encSummary, target: { metric: "p99", maxMs: 15 }, passed: gate(encSummary, { metric: "p99", maxMs: 15 }) });

    // KadaneDial prune over a realistic ~80-turn history of stored embeddings.
    const [q] = await encoder.encode(["where are we deploying?"]);
    const history: HistoryEmbedding[] = [];
    const turnVecs = await encoder.encode(Array.from({ length: 80 }, (_, i) => `history turn number ${i} about various topics`));
    turnVecs.forEach((embedding, i) => history.push({ embedding, timestampSeconds: 1_700_000_000 - i * 600 }));
    const pruneSamples = benchSync(3000, () => {
      prune(q!, history, { lambda: DEFAULT_KADANEDIAL.lambda, gainShift: DEFAULT_KADANEDIAL.gainShift, theta: DEFAULT_KADANEDIAL.theta, nowSeconds: 1_700_000_000 });
    });
    const pruneSummary = summarize(pruneSamples);
    rows.push({ label: "Pruner: KadaneDial prune (80-turn history)", summary: pruneSummary, target: { metric: "p99", maxMs: 5 }, passed: gate(pruneSummary, { metric: "p99", maxMs: 5 }) });
    // Combined encode+prune p99 vs the 20ms pruning.latency_ms target.
    const combined = summarize(encSamples.map((e, i) => e + (pruneSamples[i] ?? 0)));
    rows.push({ label: "Pruner: encode + prune combined", summary: combined, target: { metric: "p99", maxMs: 20 }, passed: gate(combined, { metric: "p99", maxMs: 20 }) });
  }

  // ── Tier-2 / Tier-3 — gated on Supabase creds ─────────────────────────────
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (url && key) {
    const client = createClient(url, key);
    const sessions = createSessionStore(client);
    const warm = createWarmMemory(client);
    const graph = createKnowledgeGraph(client);
    const vectors = createVectorStore(client);
    let orgId = "";
    try {
      orgId = await sessions.ensureOrg("Bench Tiers Org");
      out(`→ seeding a throwaway org (${orgId.slice(0, 8)}…) for Tier-2/3 latency…`);
      // Seed Tier-3: entities + an edge + 50 vectors (so queries do real work).
      // addEdge takes entity IDs (from_entity/to_entity are UUID FKs), not names —
      // capture the ids ensureEntity returns (as promoteFactsToGraph does).
      const entIds: string[] = [];
      for (let i = 0; i < 5; i++) entIds.push(await graph.ensureEntity({ orgId, kind: "Function", name: `benchFn${i}` }));
      await graph.addEdge({ orgId, fromEntity: entIds[1]!, toEntity: entIds[0]!, edgeType: "SUPERSEDES" });
      const qVec = randomUnitVector();
      await vectors.upsert(Array.from({ length: 50 }, (_, i) => ({ orgId, sourceType: "fact" as const, sourceRef: `bench-${i}`, embedding: qVec })));

      const t2 = await benchAsync(40, async () => {
        await warm.queryRecent(orgId, { limit: 20 });
      });
      const t2s = summarize(t2);
      rows.push({ label: "Tier-2 warm fact query (queryRecent, live Supabase)", summary: t2s, target: { metric: "p95", maxMs: 80 }, passed: gate(t2s, { metric: "p95", maxMs: 80 }) });

      const t3g = await benchAsync(40, async () => {
        await graph.entityStatus(orgId, "benchFn0");
      });
      const t3gs = summarize(t3g);
      rows.push({ label: "Tier-3 graph status (entity_status, live Supabase)", summary: t3gs, target: { metric: "p95", maxMs: 200 }, passed: gate(t3gs, { metric: "p95", maxMs: 200 }) });

      const t3v = await benchAsync(40, async () => {
        await vectors.search(orgId, qVec, 10);
      });
      const t3vs = summarize(t3v);
      rows.push({ label: "Tier-3 vector search (pgvector, live Supabase)", summary: t3vs, target: { metric: "p95", maxMs: 200 }, passed: gate(t3vs, { metric: "p95", maxMs: 200 }) });
    } finally {
      if (orgId) {
        for (const t of ["memory_vectors", "knowledge_edges", "knowledge_entities"]) await client.from(t).delete().eq("org_id", orgId);
        await client.from("organizations").delete().eq("id", orgId);
        out("→ cleaned up the throwaway org.");
      }
    }
  } else {
    out("→ Tier-2/3 SKIPPED (set SUPABASE_URL + SUPABASE_SERVICE_KEY to benchmark them live).");
  }

  // ── Report ────────────────────────────────────────────────────────────────
  out("");
  out(`${"tier".padEnd(48)}  ${"p50".padStart(9)}  ${"p95".padStart(9)}  ${"p99".padStart(9)}  target`);
  out("-".repeat(96));
  for (const r of rows) {
    const mark = r.passed ? "✓" : "✗";
    out(
      `  ${r.label.padEnd(46)}  ${fmt(r.summary.p50).padStart(9)}  ${fmt(r.summary.p95).padStart(9)}  ${fmt(r.summary.p99).padStart(9)}  ` +
        `${r.target.metric} < ${r.target.maxMs}ms  ${mark}`,
    );
  }
  const failed = rows.filter((r) => !r.passed);
  out("");
  if (failed.length === 0) {
    out(`RESULT: PASS — all ${rows.length} measured tiers within target.`);
    return 0;
  }
  out(`RESULT: ${failed.length}/${rows.length} tier(s) OVER target: ${failed.map((r) => r.label).join("; ")}.`);
  out("NOTE: ONNX/laptop variance — the encode target assumes a 'mid-range developer laptop' (BLUEPRINT §ONNX);");
  out("a single over-target measurement on a loaded CI box is a calibration note, not necessarily a regression.");
  return 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("bench-tiers.ts") || entryPath.endsWith("bench-tiers.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`bench-tiers failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
