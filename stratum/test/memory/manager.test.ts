// v0.5.x ship-gate criterion: "fact survives 50 turns". A load-bearing decision
// stated once ages out of the hot window, is distilled to a typed fact, and is
// still recalled from warm memory 50 turns later. Deterministic clock + a fake
// extraction completion (emits the fact ONLY for the decision transcript) + the
// fake Supabase client — no creds, no model.

import { describe, test, expect } from "vitest";
import { createMemoryManager } from "../../src/memory/manager";
import { createWarmMemory, type WarmMemory } from "../../src/memory/warm/tier2";
import { createFactExtractor, type FactCompletion } from "../../src/memory/warm/extractor";
import { makeFakeSupabase } from "./fake-supabase";
import type { AnyFact } from "../../src/types/facts";
import type { VectorStore } from "../../src/memory/cold/vectors";
import type { BiEncoder } from "../../src/pruner/encoder";

describe("MemoryManager — fact survives 50 turns", () => {
  test("a decision evicted from hot memory is recalled from warm 50 turns later", async () => {
    const { client, store } = makeFakeSupabase();
    const warm = createWarmMemory(client);

    // Fake extraction model: emit a TechDecision ONLY for the transcript carrying
    // the load-bearing decision ("RS256"); noise turns extract to nothing.
    let mintSeq = 0;
    const fake: FactCompletion = {
      complete: (prompt: string) =>
        Promise.resolve(
          prompt.includes("RS256")
            ? '[{"fact_type":"TechDecision","decision_text":"use RS256 for JWT signing","domain":"auth","confidence":0.95}]'
            : "[]",
        ),
    };
    const extractor = createFactExtractor(fake, {
      now: () => "2026-05-29T00:00:00Z",
      mintId: () => `bbbbbbbb-bbbb-bbbb-bbbb-${String(++mintSeq).padStart(12, "0")}`,
    });

    // Deterministic hot clock: now() == the latest ingested turn's time. A 5s
    // window (= 5 turns at 1s spacing) ages turn 0 out by ~turn 6.
    let clockMs = 0;
    const manager = createMemoryManager({
      extractor,
      warm,
      context: { orgId: "org-1", sessionId: "sess-1" },
      hotOptions: { windowMs: 5000, now: () => clockMs },
    });

    // Turn 0: the decision.
    await manager.ingest({ role: "user", content: "Decision: we will use RS256 for JWT signing.", timestamp: 0 });

    // 50 noise turns, 1s apart — pushes the decision out of the hot window.
    for (let i = 1; i <= 50; i++) {
      clockMs = i * 1000;
      await manager.ingest({ role: "user", content: `noise turn ${i} about unrelated logo alignment`, timestamp: i * 1000 });
    }

    // The decision is no longer in hot memory (it aged out)…
    expect(manager.hot.recent().some((t) => String(t.content).includes("RS256"))).toBe(false);

    // …but recall surfaces it from WARM — it survived 50 turns.
    const { hotTurns, facts } = await manager.recall();
    expect(hotTurns.some((t) => String(t.content).includes("RS256"))).toBe(false);
    const rs256 = facts.find(
      (f) => f.fact_type === "TechDecision" && (f as { decision_text?: string }).decision_text?.includes("RS256"),
    );
    expect(rs256).toBeDefined();
    expect(rs256!.session_id).toBe("sess-1"); // trusted FK applied on persist

    // Exactly one decision persisted; the 50 noise turns produced no facts.
    expect((store["tech_decisions"] ?? []).length).toBe(1);
  });

  test("flush() drains the remaining hot window at session end", async () => {
    const { client, store } = makeFakeSupabase();
    const warm = createWarmMemory(client);
    const extractor = createFactExtractor(
      { complete: (p: string) => Promise.resolve(p.includes("RS256") ? '[{"fact_type":"TechDecision","decision_text":"use RS256","domain":"auth","confidence":0.9}]' : "[]") },
      { now: () => "2026-05-29T00:00:00Z", mintId: () => "cccccccc-cccc-cccc-cccc-cccccccccccc" },
    );
    let clockMs = 0;
    const manager = createMemoryManager({ extractor, warm, context: { orgId: "o", sessionId: "s" }, hotOptions: { windowMs: 1_000_000, now: () => clockMs } });

    await manager.ingest({ role: "user", content: "Decision: use RS256.", timestamp: 0 });
    // Still inside the (huge) window → not yet evicted, so not yet in warm.
    expect((store["tech_decisions"] ?? []).length).toBe(0);

    // Advance the clock past the window and flush at session end.
    clockMs = 2_000_000;
    await manager.flush();
    expect((store["tech_decisions"] ?? []).length).toBe(1);
  });

  test("drain FAILS LOUD + re-queues (no fact loss) on persist error; retry succeeds", async () => {
    // A WarmMemory whose persist FAILS the first time, succeeds the second — proves
    // the evicted turn is NOT dropped (the pre-fix bug) but re-queued for retry.
    let persistCalls = 0;
    const persisted: AnyFact[] = [];
    const warm: WarmMemory = {
      async persist(facts) {
        persistCalls++;
        if (persistCalls === 1) return { persisted: 0, skipped: 0, errors: [{ table: "tech_decisions", message: "transient" }] };
        persisted.push(...facts);
        return { persisted: facts.length, skipped: 0, errors: [] };
      },
      async queryRecent() {
        return [];
      },
      async queryUnpromoted() {
        return [];
      },
      async markPromoted() {
        return 0;
      },
      async getFactsByRefs() {
        return new Map();
      },
    };
    const extractor = createFactExtractor(
      { complete: (p: string) => Promise.resolve(p.includes("RS256") ? '[{"fact_type":"TechDecision","decision_text":"use RS256","domain":"auth","confidence":0.9}]' : "[]") },
      { now: () => "2026-05-29T00:00:00Z", mintId: () => "dddddddd-dddd-dddd-dddd-dddddddddddd" },
    );
    let clockMs = 0;
    const manager = createMemoryManager({ extractor, warm, context: { orgId: "o", sessionId: "s" }, hotOptions: { windowMs: 1000, now: () => clockMs } });

    await manager.ingest({ role: "user", content: "Decision: use RS256.", timestamp: 0 });
    clockMs = 5000; // ages turn 0 out of the 1s window
    await expect(manager.flush()).rejects.toThrow(/persist failed/i); // FAIL-LOUD, not silent loss
    expect(persisted).toHaveLength(0); // nothing durably stored on the failed attempt

    // The evicted turn was RE-QUEUED, not lost: the retry drain now succeeds.
    await manager.flush();
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { decision_text?: string }).decision_text).toContain("RS256");
  });
});

describe("MemoryManager — Tier-3 semantic recall (opt-in)", () => {
  const noExtract = createFactExtractor({ complete: () => Promise.resolve("[]") }, { now: () => "2026-05-29T00:00:00Z", mintId: () => "x" });

  test("a query returns vector neighbours resolved to typed facts (offline encoder)", async () => {
    const { client } = makeFakeSupabase({
      tech_decisions: [
        { id: "f-1", created_at: "2026-05-29T00:00:00Z", org_id: "org-1", session_id: "sess-1", confidence: 0.9, is_verified: false, is_suppressed: false, promoted_to_t3: true, decision_text: "use Cloudflare Workers", domain: "infra" },
      ],
    });
    const warm = createWarmMemory(client);
    const vectors: VectorStore = {
      upsert: () => Promise.resolve(0),
      search: () => Promise.resolve([{ id: "v1", sourceType: "fact", sourceRef: "f-1", similarity: 0.88 }]),
    };
    const encoder: BiEncoder = { dimension: 384, encode: (texts) => Promise.resolve(texts.map(() => new Float32Array(384))) };
    const manager = createMemoryManager({ extractor: noExtract, warm, context: { orgId: "org-1", sessionId: "sess-1" }, vectors, encoder });

    const { relevantFacts } = await manager.recall({ query: "where do we deploy?" });
    expect(relevantFacts).toBeDefined();
    expect(relevantFacts!.map((f) => (f as { decision_text?: string }).decision_text)).toEqual(["use Cloudflare Workers"]);
  });

  test("a query WITHOUT a configured vector store + encoder → no relevantFacts (backward compatible)", async () => {
    const { client } = makeFakeSupabase();
    const warm = createWarmMemory(client);
    const manager = createMemoryManager({ extractor: noExtract, warm, context: { orgId: "o", sessionId: "s" } });
    const r = await manager.recall({ query: "anything" });
    expect(r.relevantFacts).toBeUndefined();
    expect(r.hotTurns).toEqual([]); // still returns the deterministic hot+warm shape
  });
});
