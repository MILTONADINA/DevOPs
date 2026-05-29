// Unit tests for the deterministic eval-gate engine (compare / golden / report)
// + the runner orchestration (with injected fake Answerer/Judge) + the gated
// metric-source factories. No LLM judge, no datasets — this is the
// dataset/judge-agnostic decision logic, which is the actual PASS/FAIL gate.

import { describe, test, expect } from "vitest";
import { gateMetric, gateScenario } from "../../evals/harness/compare";
import { checkGoldenQuery, criticalFailures } from "../../evals/harness/golden";
import { evaluateSuite, renderReport, type SuiteResult } from "../../evals/harness/report";
import { runScenario, runSuite, type ScenarioInput } from "../../evals/harness/runner";
import { createClaudeAnswerer, createLlmJudge, type Answerer, type Judge } from "../../evals/harness/metrics";
import { DEFAULT_THRESHOLDS, type GoldenQuery, type ScenarioResult } from "../../evals/harness/types";

const { faithfulnessMin, answerRelevancyMin, maxDegradation } = DEFAULT_THRESHOLDS;

describe("gateMetric", () => {
  test("passes when above floor and within degradation tolerance", () => {
    const v = gateMetric("faithfulness", 0.93, 0.95, faithfulnessMin, maxDegradation);
    expect(v.passed).toBe(true);
    expect(v.delta).toBeCloseTo(-0.02, 6);
    expect(v.reason).toBeUndefined();
  });

  test("fails when pruned score is below the absolute floor", () => {
    const v = gateMetric("faithfulness", 0.889, 0.9, faithfulnessMin, maxDegradation);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/below floor/);
  });

  test("fails on excessive degradation even when above the floor", () => {
    // pruned 0.93 ≥ 0.90 floor, but baseline 0.99 → degradation 0.06 ≥ 0.05.
    const v = gateMetric("faithfulness", 0.93, 0.99, faithfulnessMin, maxDegradation);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/degradation/);
  });

  test("floor is inclusive (score exactly at minimum passes)", () => {
    const v = gateMetric("answerRelevancy", answerRelevancyMin, answerRelevancyMin, answerRelevancyMin, maxDegradation);
    expect(v.passed).toBe(true);
  });
});

describe("gateScenario", () => {
  const mk = (pf: number, pa: number, bf: number, ba: number): ScenarioResult => ({
    tier: "B",
    name: "func_deprecation",
    pruned: { faithfulness: pf, answerRelevancy: pa },
    baseline: { faithfulness: bf, answerRelevancy: ba },
  });

  test("passes only when BOTH metrics pass", () => {
    expect(gateScenario(mk(0.95, 0.92, 0.96, 0.93), DEFAULT_THRESHOLDS).passed).toBe(true);
    // answerRelevancy below floor → scenario fails
    expect(gateScenario(mk(0.95, 0.80, 0.96, 0.93), DEFAULT_THRESHOLDS).passed).toBe(false);
  });
});

describe("checkGoldenQuery", () => {
  const q: GoldenQuery = {
    id: "gc-001",
    scenario: "function_deprecation",
    query: "Which function fetches a user?",
    expectedContains: ["fetchUser"],
    expectedNotContains: ["getUser"],
    critical: true,
  };

  test("passes when required present and forbidden absent", () => {
    const r = checkGoldenQuery("use fetchUser() to load the record", q);
    expect(r.passed).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.leaked).toEqual([]);
  });

  test("fails (missing) when a required anchor is absent", () => {
    const r = checkGoldenQuery("use the user loader", q);
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(["fetchUser"]);
  });

  test("fails (leaked) when a forbidden anchor is present", () => {
    // contains the deprecated getUser AND lacks fetchUser → both missing + leaked
    const r = checkGoldenQuery("the old getUser still here", q);
    expect(r.passed).toBe(false);
    expect(r.leaked).toEqual(["getUser"]);
  });

  test("is case-sensitive (identifier semantics)", () => {
    const r = checkGoldenQuery("use FetchUser (wrong case)", q);
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(["fetchUser"]);
  });

  test("criticalFailures counts only failing critical queries", () => {
    const nonCrit: GoldenQuery = { ...q, id: "gc-002", critical: false };
    const results = [checkGoldenQuery("nope", q), checkGoldenQuery("nope", nonCrit)];
    expect(criticalFailures(results)).toBe(1);
  });
});

describe("evaluateSuite + renderReport", () => {
  const passScenario = gateScenario(
    { tier: "A", name: "LoCoMo", pruned: { faithfulness: 0.924, answerRelevancy: 0.911 }, baseline: { faithfulness: 0.93, answerRelevancy: 0.92 } },
    DEFAULT_THRESHOLDS,
  );
  const failScenario = gateScenario(
    { tier: "B", name: "multi_project", pruned: { faithfulness: 0.889, answerRelevancy: 0.872 }, baseline: { faithfulness: 0.94, answerRelevancy: 0.93 } },
    DEFAULT_THRESHOLDS,
  );
  const goldenPass = checkGoldenQuery("fetchUser", {
    id: "gc-001", scenario: "fd", query: "q", expectedContains: ["fetchUser"], expectedNotContains: [], critical: true,
  });
  const goldenCritFail = checkGoldenQuery("getUser", {
    id: "gc-002", scenario: "fd", query: "q", expectedContains: ["fetchUser"], expectedNotContains: ["getUser"], critical: true,
  });

  test("all-pass suite → PASS", () => {
    const result: SuiteResult = { scenarios: [passScenario], golden: [goldenPass] };
    const verdict = evaluateSuite(result);
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    const report = renderReport(result, verdict);
    expect(report).toContain("Tier A — Published Benchmarks");
    expect(report).toContain("RESULT: PASS");
    expect(report).toContain("1/1 passed");
  });

  test("scenario below threshold → FAIL with action + marker", () => {
    const result: SuiteResult = { scenarios: [passScenario, failScenario], golden: [goldenPass] };
    const verdict = evaluateSuite(result);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]).toMatch(/multi_project/);
    const report = renderReport(result, verdict);
    expect(report).toContain("← BELOW THRESHOLD");
    expect(report).toContain("RESULT: FAIL");
    expect(report).toContain("Action required:");
  });

  test("critical golden failure fails the suite even if all scenarios pass", () => {
    const result: SuiteResult = { scenarios: [passScenario], golden: [goldenCritFail] };
    const verdict = evaluateSuite(result);
    expect(verdict.passed).toBe(false);
    expect(verdict.criticalGoldenFailures).toBe(1);
    expect(verdict.actionRequired).toMatch(/critical fact/i);
  });

  test("non-critical golden miss is surfaced but does not fail the suite", () => {
    const nonCritMiss = checkGoldenQuery("nope", {
      id: "gc-003", scenario: "fd", query: "q", expectedContains: ["fetchUser"], expectedNotContains: [], critical: false,
    });
    const result: SuiteResult = { scenarios: [passScenario], golden: [goldenPass, nonCritMiss] };
    const verdict = evaluateSuite(result);
    expect(verdict.passed).toBe(true);
    expect(verdict.goldenPassed).toBe(1);
    expect(verdict.goldenTotal).toBe(2);
  });
});

describe("runner orchestration (injected fakes)", () => {
  // Fake answerer echoes nothing; fake judge scores the CONTEXT it was given:
  // a context containing the decision anchor scores high, one without scores low.
  const answerer: Answerer = { generate: (_q, ctx) => Promise.resolve(`answer-for:${ctx.includes("DECISION") ? "informed" : "blind"}`) };
  const judge: Judge = {
    score: ({ context }) =>
      Promise.resolve(context.includes("DECISION") ? { faithfulness: 0.95, answerRelevancy: 0.93 } : { faithfulness: 0.82, answerRelevancy: 0.80 }),
  };

  const scenario: ScenarioInput = {
    tier: "B",
    name: "tech_migration",
    query: "which database did we choose?",
    fullContext: "turn1 ... DECISION: use Supabase ... turn80",
    // pruning drops the decision turn → context loses the anchor
    prune: (full) => full.replace("DECISION: use Supabase", "(turn pruned)"),
  };

  test("runScenario scores pruned vs baseline from the right contexts", async () => {
    const r = await runScenario(scenario, answerer, judge);
    expect(r.baseline).toEqual({ faithfulness: 0.95, answerRelevancy: 0.93 }); // full context kept the decision
    expect(r.pruned).toEqual({ faithfulness: 0.82, answerRelevancy: 0.80 }); // pruned dropped it
  });

  test("runSuite gates a quality-destroying prune as FAIL", async () => {
    const golden = [{ query: { id: "gc-1", scenario: "tm", query: "q", expectedContains: ["Supabase"], expectedNotContains: [], critical: true }, prunedContextText: scenario.prune(scenario.fullContext, scenario.query) as string }];
    const { verdict } = await runSuite([scenario], golden, answerer, judge);
    expect(verdict.passed).toBe(false); // pruned faithfulness 0.82 < 0.90 floor AND critical golden lost "Supabase"
    expect(verdict.criticalGoldenFailures).toBe(1);
  });
});

describe("gated metric sources", () => {
  test("createLlmJudge().score rejects (never fabricates scores)", async () => {
    await expect(createLlmJudge().score({ query: "q", context: "c", answer: "a" })).rejects.toThrow(/GATED|ANTHROPIC_API_KEY/);
  });
  test("createClaudeAnswerer().generate rejects until configured", async () => {
    await expect(createClaudeAnswerer().generate("q", "c")).rejects.toThrow(/GATED|ANTHROPIC_API_KEY/);
  });
});
