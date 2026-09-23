// Unit tests for the Tier-B dataset loader (pure — no model, no API) + the
// fixture's structural integrity (every scenario well-formed).

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDevScenarios, toGoldenQuery } from "../../evals/harness/dataset";

const rec = (o: unknown): string => JSON.stringify(o);

describe("parseDevScenarios", () => {
  test("parses a valid scenario line", () => {
    const line = rec({
      id: "tb-x",
      scenario: "demo",
      query: "what db?",
      golden: { contains: ["Supabase"], notContains: ["Mongo"], critical: true },
      turns: [{ text: "we chose Supabase", ageHours: 2 }],
    });
    const [s] = parseDevScenarios(line);
    expect(s).toBeDefined();
    expect(s!.id).toBe("tb-x");
    expect(s!.turns).toHaveLength(1);
    expect(s!.golden.contains).toEqual(["Supabase"]);
    expect(toGoldenQuery(s!)).toMatchObject({ expectedContains: ["Supabase"], expectedNotContains: ["Mongo"], critical: true });
  });

  test("skips blank lines + parses multiple", () => {
    const jsonl = [
      rec({ id: "a", query: "q", golden: { contains: [], notContains: [], critical: false }, turns: [{ text: "t", ageHours: 1 }] }),
      "",
      rec({ id: "b", query: "q", golden: { contains: [], notContains: [], critical: false }, turns: [{ text: "t", ageHours: 1 }] }),
    ].join("\n");
    expect(parseDevScenarios(jsonl)).toHaveLength(2);
  });

  test("rejects malformed golden / missing fields", () => {
    expect(() => parseDevScenarios(rec({ id: "x", query: "q", turns: [] }))).toThrow(/golden/);
    expect(() => parseDevScenarios(rec({ id: "x", golden: { contains: [], notContains: [], critical: true } }))).toThrow(/id\/query\/turns/);
    expect(() => parseDevScenarios(rec({ id: "x", query: "q", golden: { contains: ["k"], notContains: [], critical: true }, turns: [{ text: "t" }] }))).toThrow(/ageHours/);
    // A CRITICAL golden with no assertions must be rejected (it would pass the hard gate vacuously).
    expect(() => parseDevScenarios(rec({ id: "x", query: "q", golden: { contains: [], notContains: [], critical: true }, turns: [{ text: "t", ageHours: 1 }] }))).toThrow(/pass vacuously/);
  });
});

describe("tier-b.jsonl fixture integrity", () => {
  test("every shipped scenario is well-formed + critical with ≥3 turns", () => {
    const file = join(process.cwd(), "evals", "datasets", "developer", "tier-b.jsonl");
    const scenarios = parseDevScenarios(readFileSync(file, "utf8"));
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    for (const s of scenarios) {
      expect(s.turns.length).toBeGreaterThanOrEqual(3); // a buried fact needs noise around it
      expect(s.golden.contains.length).toBeGreaterThanOrEqual(1); // a fact must survive
      expect(s.golden.critical).toBe(true);
      expect(s.query.length).toBeGreaterThan(0);
    }
  });
});
