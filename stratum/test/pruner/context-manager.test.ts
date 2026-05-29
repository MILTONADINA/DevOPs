// End-to-end integration test for the shadow context manager: composes a fake
// encoder + real Tier-1 hot memory + the real KadaneDial pruner. Deterministic
// (injected encoder + clock), no model/API. Proves the pieces compose: ingest
// stores embeddings; select prunes the window to the relevant turn(s).

import { describe, test, expect } from "vitest";
import { createContextManager } from "../../src/pruner/context-manager";
import { createHotMemory } from "../../src/memory/hot/tier1";
import type { BiEncoder } from "../../src/pruner/encoder";

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);
// "database/Supabase" content aligns with a DB query (axis 0); everything else is orthogonal.
const fakeEncoder: BiEncoder = {
  dimension: 2,
  encode: (texts) => Promise.resolve(texts.map((t) => (/database|supabase/i.test(t) ? v(1, 0) : v(0, 1)))),
};

const NOW = 1_700_000_000_000; // ms

describe("ShadowContextManager (encoder + Tier-1 + pruner integration)", () => {
  test("ingest stores turns + embeddings; select prunes to the relevant turn", async () => {
    const cm = createContextManager(fakeEncoder, { hot: createHotMemory({ now: () => NOW }) });
    await cm.ingest({ role: "user", content: "We chose Supabase for the database.", timestampMs: NOW - 3000 });
    await cm.ingest({ role: "user", content: "Fix the button CSS padding.", timestampMs: NOW - 2000 });
    await cm.ingest({ role: "user", content: "Add a dark mode toggle.", timestampMs: NOW - 1000 });

    expect(cm.hot.size()).toBe(3);
    expect(cm.hot.recent()[0]!.embedding).toBeInstanceOf(Float32Array); // embedding stored at ingest

    const { decision, selectedTurns } = await cm.select("Which database do we use?", NOW);
    expect(selectedTurns.map((t) => t.content)).toEqual(["We chose Supabase for the database."]);
    expect(decision.prunedIndices.length).toBe(2); // the two off-topic turns dropped
  });

  test("empty hot memory → select returns no turns", async () => {
    const cm = createContextManager(fakeEncoder, { hot: createHotMemory({ now: () => NOW }) });
    const { selectedTurns } = await cm.select("anything relevant?", NOW);
    expect(selectedTurns).toEqual([]);
  });

  test("turns outside the window are evicted before selection", async () => {
    const cm = createContextManager(fakeEncoder, { hot: createHotMemory({ windowMs: 5000, now: () => NOW }) });
    await cm.ingest({ role: "user", content: "We chose Supabase for the database.", timestampMs: NOW - 60_000 }); // 60s old → outside a 5s window
    await cm.ingest({ role: "user", content: "Use the database for sessions too.", timestampMs: NOW - 1000 }); // fresh + relevant
    const { selectedTurns } = await cm.select("database?", NOW);
    // only the in-window relevant turn survives
    expect(selectedTurns.map((t) => t.content)).toEqual(["Use the database for sessions too."]);
  });
});
