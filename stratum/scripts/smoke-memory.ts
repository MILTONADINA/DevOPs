/**
 * Live end-to-end smoke of the v0.5.x memory pipeline (MANUAL / gated). Proves the
 * WHOLE chain on REAL infra — not fakes:
 *   real Claude (Haiku) extraction  →  Tier-2 warm persist (live Supabase)
 *   →  promote to Tier-3 graph + pgvector (real OFFLINE ONNX encoder)
 *   →  recall (queryRecent + find_superseded + understandEntity + vector search).
 * Then deletes everything it created.
 *
 *   npm run smoke:memory
 *
 * GATED: needs ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY in .env. With
 * any missing it SKIPs cleanly (exit 0). Makes real (paid) API calls + writes to the
 * live DB; first run downloads the ~23MB embedding model to the gitignored models/.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createClaudeCompletion } from "../evals/harness/metrics";
import { createFactExtractor } from "../src/memory/warm/extractor";
import { createWarmMemory } from "../src/memory/warm/tier2";
import { createSessionStore } from "../src/memory/warm/sessions";
import { createKnowledgeGraph } from "../src/memory/cold/graph";
import { createVectorStore } from "../src/memory/cold/vectors";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { promoteFacts } from "../src/memory/promote";
import { understandEntity } from "../src/memory/understand";
import { join } from "node:path";

const TRANSCRIPT = [
  { role: "user", content: "We deprecated the getUser function and renamed it to fetchUser across the auth module." },
  { role: "assistant", content: "Got it — getUser is deprecated in favour of fetchUser." },
  { role: "user", content: "Decision: we'll deploy on Cloudflare Workers instead of AWS Lambda for the edge latency." },
  { role: "user", content: "Also set the PII redaction policy to fail-closed, and add a TODO to ship the tier-2 adapter." },
];

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  const anthropic = process.env["ANTHROPIC_API_KEY"];
  if (!url || !key || !anthropic) {
    out("SKIP: needs ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY in .env — the live memory pipeline is gated on those.");
    return 0;
  }

  const client = createClient(url, key);
  const warm = createWarmMemory(client);
  const sessions = createSessionStore(client);
  const graph = createKnowledgeGraph(client);
  const vectors = createVectorStore(client);
  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const extractor = createFactExtractor(createClaudeCompletion({ model: "claude-haiku-4-5-20251001" }));

  let orgId = "";
  let sessionId = "";
  let exitCode = 0;
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    // 1) REAL extraction (live Claude Haiku).
    out("→ extracting facts from the transcript via Claude Haiku…");
    const facts = await extractor.extract({ session_id: "logical", turns: TRANSCRIPT });
    out(`  extracted ${facts.length} fact(s): ${facts.map((f) => f.fact_type).join(", ")}`);
    checks.push({ name: "real LLM extracted ≥1 durable fact", ok: facts.length >= 1, detail: `count=${facts.length}` });

    // 2) Trusted FKs + live warm persist.
    orgId = await sessions.ensureOrg("Smoke Memory Org");
    sessionId = await sessions.createSession({ orgId, model: "claude-opus-4-8" });
    const persistRes = await warm.persist(facts, { orgId, sessionId });
    checks.push({ name: "warm persist wrote all extracted facts (live Supabase)", ok: persistRes.persisted === facts.length && persistRes.errors.length === 0, detail: JSON.stringify(persistRes) });

    // 3) Read back from warm.
    const recalled = await warm.queryRecent(orgId, { sessionId });
    checks.push({ name: "queryRecent round-trips the persisted facts", ok: recalled.length === facts.length, detail: `recalled=${recalled.length}` });

    // 4) Promote to Tier-3 graph + vectors (real offline encoder).
    out("→ promoting to Tier-3 (graph + pgvector via the ONNX encoder; first run downloads the model)…");
    const promo = await promoteFacts({ graph, vectors, encoder }, facts, { orgId, sessionId });
    checks.push({ name: "promote created ≥1 graph entity", ok: promo.entities >= 1, detail: JSON.stringify(promo) });

    // 5) Semantic recall over the vectors (encode a query, search).
    const [qVec] = await encoder.encode(["where are we deploying the service?"]);
    const hits = qVec ? await vectors.search(orgId, Array.from(qVec), 5) : [];
    checks.push({ name: "vector search returns ≥1 promoted neighbour", ok: hits.length >= 1, detail: `hits=${hits.length}` });

    // 6) Best-effort graph recall (LLM-variance-tolerant): if a FunctionChange with a
    //    new_name was extracted, the SUPERSEDES edge + find_superseded should reflect it.
    const fc = facts.find((f) => f.fact_type === "FunctionChange" && (f as { new_name?: string }).new_name);
    if (fc) {
      const oldName = (fc as { old_name: string }).old_name;
      const newName = (fc as { new_name?: string }).new_name as string;
      const sup = await graph.findSuperseded(orgId, [oldName, newName]);
      const status = await understandEntity(graph, orgId, oldName);
      out(`  find_superseded([${oldName}, ${newName}]) → ${JSON.stringify(sup)}`);
      out(`  understandEntity(${oldName}) → isSuperseded=${status.isSuperseded}, supersededBy=${JSON.stringify(status.supersededBy)}`);
      checks.push({ name: "graph: extracted rename produced a SUPERSEDES relation", ok: sup.some((s) => s.superseded === oldName && s.supersededBy === newName), detail: JSON.stringify(sup) });
    } else {
      out("  (no FunctionChange with new_name extracted this run — skipping the supersession assertion; LLM variance)");
    }

    out("");
    for (const ch of checks) out(`  ${ch.ok ? "✓" : "✗"} ${ch.name} — ${ch.detail}`);
    const passed = checks.every((ch) => ch.ok);
    out("");
    out(passed ? "RESULT: PASS — live v0.5.x memory pipeline verified end-to-end." : "RESULT: FAIL — see checks above.");
    exitCode = passed ? 0 : 1;
  } catch (err) {
    out(`FAIL: pipeline threw — ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    if (orgId) {
      for (const t of ["function_changes", "tech_decisions", "policy_updates", "todos", "variable_changes", "memory_vectors", "knowledge_edges", "knowledge_entities"]) {
        await client.from(t).delete().eq("org_id", orgId);
      }
      if (sessionId) await client.from("sessions").delete().eq("id", sessionId);
      await client.from("organizations").delete().eq("id", orgId);
      out("→ cleaned up the throwaway org + all its memory rows.");
    }
  }
  return exitCode;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("smoke-memory.ts") || entryPath.endsWith("smoke-memory.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
