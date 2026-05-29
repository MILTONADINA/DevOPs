// v0.5.x ship-gate criterion: "fact survives 50 turns". A load-bearing decision
// stated once ages out of the hot window, is distilled to a typed fact, and is
// still recalled from warm memory 50 turns later. Deterministic clock + a fake
// extraction completion (emits the fact ONLY for the decision transcript) + the
// fake Supabase client — no creds, no model.

import { describe, test, expect } from "vitest";
import { createMemoryManager } from "../../src/memory/manager";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { createFactExtractor, type FactCompletion } from "../../src/memory/warm/extractor";
import { makeFakeSupabase } from "./fake-supabase";

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
});
