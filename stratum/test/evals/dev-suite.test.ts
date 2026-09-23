// Regression tests for the Tier-B pipeline's PRUNING BEHAVIOR — deterministic,
// no model + no API (fake encoder encodes the semantic structure; fake judge
// scores from context). Guards the headline claims the eval:tierb commit made
// ("no Atlas leak", "temporal decay drops stale config") against silent
// keep-everything regressions, which the unit gate + manual eval miss.

import { describe, test, expect } from "vitest";
import { join } from "node:path";
import type { BiEncoder } from "../../src/pruner/encoder";
import type { Answerer, Judge } from "../../evals/harness/metrics";
import { loadDevScenarios, toGoldenQuery } from "../../evals/harness/dataset";
import { runDevScenario } from "../../evals/harness/dev-suite";
import { checkGoldenQuery } from "../../evals/harness/golden";

const NOW = 1_700_000_000;
const TIERB = join(process.cwd(), "evals", "datasets", "developer", "tier-b.jsonl");
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

// Fake judge: faithful iff the pruned context kept the golden anchor.
const judgeFor = (anchor: string): Judge => ({
  score: ({ context }) => Promise.resolve(context.includes(anchor) ? { faithfulness: 1, answerRelevancy: 1 } : { faithfulness: 0.5, answerRelevancy: 0.5 }),
});
const fakeAnswerer: Answerer = { generate: () => Promise.resolve("(answer)") };

function scenario(id: string) {
  const s = loadDevScenarios(TIERB).find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} not found`);
  return s;
}

describe("Tier-B pruning behavior (deterministic, fake encoder)", () => {
  test("multi_project_bleed: keeps the relevant Borealis turn, drops Atlas (no cross-project leak)", async () => {
    const scn = scenario("tb-multiproject");
    // Semantic relevance to the auth query: the Borealis AUTH turn aligns fully
    // (sim 1); the other Borealis turn (storage) is partial (sim 0.5); Atlas
    // turns are orthogonal (sim 0). Mirrors the real eval (kept only turn 1).
    const enc: BiEncoder = {
      dimension: 2,
      encode: (texts) =>
        Promise.resolve(texts.map((t) => (/Clerk|authentication/.test(t) ? v(1, 0) : /Borealis/.test(t) ? v(0.5, Math.sqrt(0.75)) : v(0, 1)))),
    };
    const o = await runDevScenario(scn, enc, fakeAnswerer, judgeFor("Clerk"), NOW);
    expect(o.decision.selectedIndices).toEqual([1]); // the Clerk/auth turn
    expect(o.prunedText).toContain("Clerk");
    expect(o.prunedText).not.toMatch(/Stripe|atlas-gateway/); // no Atlas leak
    expect(checkGoldenQuery(o.prunedText, toGoldenQuery(scn)).passed).toBe(true);
  });

  test("stale_config_decay: temporal decay drops the 96h-old api-v1, keeps the 2h-old api-v2", async () => {
    const scn = scenario("tb-staleconfig");
    // Both API-URL turns align with the query (axis 0); the Tailwind noise is
    // orthogonal. Only temporal decay (turn0 is 96h old) separates v1 from v2.
    const enc: BiEncoder = {
      dimension: 2,
      encode: (texts) => Promise.resolve(texts.map((t) => (/API base URL/.test(t) ? v(1, 0) : v(0, 1)))),
    };
    const o = await runDevScenario(scn, enc, fakeAnswerer, judgeFor("api-v2"), NOW);
    expect(o.decision.selectedIndices).toEqual([2]); // only the current url survives
    expect(o.prunedText).toContain("api-v2");
    expect(o.prunedText).not.toContain("api-v1");
    expect(checkGoldenQuery(o.prunedText, toGoldenQuery(scn)).passed).toBe(true);
  });

  test("EVERY scenario has a working over-leniency guard: a keep-everything pruner fails its golden", () => {
    // For each scenario, a keep-all prune leaks its must-drop notContains token →
    // golden fails. This also validates that every authored notContains token is
    // genuinely PRESENT in the turns (a mis-authored/absent token would let
    // keep-all pass and fail this assertion).
    const all = loadDevScenarios(TIERB);
    expect(all.length).toBeGreaterThanOrEqual(11);
    for (const scn of all) {
      const keepAllText = scn.turns.map((t) => t.text).join("\n");
      expect(checkGoldenQuery(keepAllText, toGoldenQuery(scn)).passed, `${scn.id} keep-all must fail golden`).toBe(false);
    }
  });
});
