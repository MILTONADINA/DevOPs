// Unit tests for Phase-3 memory pieces that are pure + ungated: Tier-1 hot
// memory (rolling window + time eviction) and the Zod fact-validation layer.
// The Tier-2/3 adapters (Supabase/Neo4j/Pinecone) are gated on those services.

import { describe, test, expect } from "vitest";
import { createHotMemory, type HotTurn } from "../../src/memory/hot/tier1";
import { validateFact } from "../../src/memory/warm/schemas";
import { parseExtractedFacts, createFactExtractor, extractionPrompt, type FactCompletion } from "../../src/memory/warm/extractor";
import type { AnyFact } from "../../src/types/facts";

const T0 = 1_700_000_000_000; // fixed base ms

describe("Tier-1 hot memory (rolling window)", () => {
  test("add + recent preserves ascending time order; size tracks count", () => {
    let t = T0;
    const hot = createHotMemory({ now: () => t });
    hot.add({ timestamp: t, role: "user", content: "a" });
    t += 1000;
    hot.add({ timestamp: t, role: "assistant", content: "b" });
    expect(hot.size()).toBe(2);
    expect(hot.recent().map((x) => x.content)).toEqual(["a", "b"]);
  });

  test("evicts turns older than the window and hands them to onEvict", () => {
    let t = T0;
    const evicted: HotTurn[] = [];
    const hot = createHotMemory({ windowMs: 7_200_000, now: () => t, onEvict: (x) => evicted.push(x) });
    hot.add({ timestamp: t, role: "user", content: "old" }); // at T0
    t += 1_000_000;
    hot.add({ timestamp: t, role: "user", content: "mid" }); // at T0+1e6
    t += 7_200_000; // advance 2h → "old" (T0) now < cutoff (now-window)
    hot.sweep();
    expect(hot.size()).toBe(1);
    expect(hot.recent()[0]!.content).toBe("mid");
    expect(evicted.map((x) => x.content)).toEqual(["old"]);
  });

  test("add triggers eviction (no separate sweep needed)", () => {
    let t = T0;
    const hot = createHotMemory({ windowMs: 1000, now: () => t });
    hot.add({ timestamp: t, role: "user", content: "x" });
    t += 5000; // x is now stale
    hot.add({ timestamp: t, role: "user", content: "y" }); // add evicts x
    expect(hot.recent().map((c) => c.content)).toEqual(["y"]);
  });

  test("out-of-order arrival is inserted in ascending order", () => {
    const t = T0;
    const hot = createHotMemory({ now: () => t });
    hot.add({ timestamp: t + 100, role: "user", content: "late" });
    hot.add({ timestamp: t + 50, role: "user", content: "early" }); // arrives later, older ts
    expect(hot.recent().map((x) => x.content)).toEqual(["early", "late"]);
  });
});

describe("Zod fact validation (validate-or-discard)", () => {
  const base = { id: "f1", created_at: "2026-05-29T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: false, is_suppressed: false };

  test("accepts a well-formed fact of each type", () => {
    const fc: AnyFact = { ...base, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "deprecated" };
    const td: AnyFact = { ...base, fact_type: "TechDecision", decision_text: "use Postgres", domain: "persistence" };
    expect(validateFact(fc)).not.toBeNull();
    expect(validateFact(td)).not.toBeNull();
    expect(validateFact({ ...base, fact_type: "Todo", description: "ship it", status: "open" })).not.toBeNull();
  });

  test("discards (null) on confidence out of [0,1], missing required field, bad enum", () => {
    expect(validateFact({ ...base, confidence: 1.5, fact_type: "TechDecision", decision_text: "x", domain: "d" })).toBeNull();
    expect(validateFact({ ...base, fact_type: "FunctionChange" /* missing old_name + change_type */ })).toBeNull();
    expect(validateFact({ ...base, fact_type: "FunctionChange", old_name: "g", change_type: "exploded" })).toBeNull();
  });

  test("discards an unknown discriminator + non-objects", () => {
    expect(validateFact({ ...base, fact_type: "Nonsense", x: 1 })).toBeNull();
    expect(validateFact(null)).toBeNull();
    expect(validateFact("not a fact")).toBeNull();
  });
});

describe("fact extractor (injected fake completion — no real model)", () => {
  const ctx = { session_id: "s9", now: () => "2026-05-29T00:00:00Z", mintId: () => "id-1" };

  test("parseExtractedFacts validates, assigns system fields, discards invalid", () => {
    const raw =
      'sure: [{"fact_type":"TechDecision","decision_text":"use Postgres","domain":"db","confidence":0.9},' +
      '{"fact_type":"Nonsense"},' +
      '{"fact_type":"Todo","description":"ship","status":"open","confidence":0.8}] (done)';
    const facts = parseExtractedFacts(raw, ctx);
    expect(facts).toHaveLength(2); // the Nonsense entry is discarded
    expect(facts[0]).toMatchObject({
      fact_type: "TechDecision",
      session_id: "s9",
      id: "id-1",
      created_at: "2026-05-29T00:00:00Z",
      is_verified: false,
      is_suppressed: false,
    });
  });

  test("non-array / no JSON / empty array → []", () => {
    expect(parseExtractedFacts("no json here", ctx)).toEqual([]);
    expect(parseExtractedFacts('{"fact_type":"Todo"}', ctx)).toEqual([]); // object, not array
    expect(parseExtractedFacts("[]", ctx)).toEqual([]);
  });

  test("createFactExtractor calls the model once for non-empty turns, skips empty", async () => {
    let calls = 0;
    const fake: FactCompletion = {
      complete: () => {
        calls++;
        return Promise.resolve('[{"fact_type":"Todo","description":"x","status":"open","confidence":1}]');
      },
    };
    const ex = createFactExtractor(fake, { now: ctx.now, mintId: ctx.mintId });
    const facts = await ex.extract({ session_id: "s9", turns: [{ role: "user", content: "todo: x" }] });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact_type).toBe("Todo");
    expect(calls).toBe(1);
    expect(await ex.extract({ session_id: "s9", turns: [] })).toEqual([]);
    expect(calls).toBe(1); // empty turns → no model call
  });

  test("extractionPrompt demands structured-only output + embeds the transcript", () => {
    const p = extractionPrompt({ session_id: "s", turns: [{ role: "user", content: "deprecate getUser" }] });
    expect(p).toMatch(/JSON array/);
    expect(p).toMatch(/NEVER summarize/i);
    expect(p).toContain("deprecate getUser");
  });
});
