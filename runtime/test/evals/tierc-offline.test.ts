import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { BiEncoder } from "../../src/pruner/encoder";
import { loadTierCCorpus, parseTierCCorpus, runTierC } from "../../evals/harness/tierc";

const CORPUS = join(process.cwd(), "evals", "datasets", "golden", "tier-c.jsonl");
const v = (...coords: number[]): Float32Array => Float32Array.from(coords);

describe("offline Tier-C gate", () => {
  test("shipped corpus is nonvacuous, critical, distinct, and defeats keep-all/keep-none", () => {
    const cases = loadTierCCorpus(CORPUS);
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(50);
    for (const entry of cases) {
      const full = entry.turns.map((turn) => turn.text).join("\n");
      expect(entry.golden.critical).toBe(true);
      expect(entry.query.trim()).not.toBe("");
      expect(entry.turns.length).toBeGreaterThanOrEqual(3);
      expect(entry.golden.contains.length).toBeGreaterThan(0);
      expect(entry.golden.notContains.length).toBeGreaterThan(0);
      for (const anchor of [...entry.golden.contains, ...entry.golden.notContains]) expect(full).toContain(anchor);
    }
  });

  test("project-scope cases carry explicit query and turn scope metadata", () => {
    const cases = loadTierCCorpus(CORPUS).filter((entry) => entry.scenario === "project_scope");
    expect(cases).toHaveLength(10);
    for (const entry of cases) {
      expect(entry.scopeId).toBeTruthy();
      expect(entry.turns.every((turn) => typeof turn.scopeId === "string" && turn.scopeId.length > 0)).toBe(true);
      expect(entry.turns.some((turn) => turn.scopeId !== entry.scopeId)).toBe(true);
    }
  });

  test("rejects project-scope cases missing trusted scope metadata", () => {
    const lines = readFileSync(CORPUS, "utf8").trim().split("\n");
    const scopedIndex = lines.findIndex((line) => line.includes('"scenario":"project_scope"'));
    const scoped = JSON.parse(lines[scopedIndex]!) as { scopeId?: string; turns: Array<{ scopeId?: string }> };
    delete scoped.scopeId;
    lines[scopedIndex] = JSON.stringify(scoped);
    expect(() => parseTierCCorpus(lines.join("\n"))).toThrow(/project scope metadata required/);
    scoped.scopeId = "orion";
    delete scoped.turns[0]!.scopeId;
    lines[scopedIndex] = JSON.stringify(scoped);
    expect(() => parseTierCCorpus(lines.join("\n"))).toThrow(/project scope metadata required/);
  });

  test("rejects a corpus with too few cases before running a vacuous gate", () => {
    const first49 = readFileSync(CORPUS, "utf8").trim().split("\n").slice(0, 49).join("\n");
    expect(() => parseTierCCorpus(first49)).toThrow(/at least 50/);
  });

  test("rejects duplicate queries and invalid turn ages", () => {
    const lines = readFileSync(CORPUS, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!) as { query: string; turns: Array<{ ageHours: number }> };
    const second = JSON.parse(lines[1]!) as { query: string };
    second.query = first.query;
    lines[1] = JSON.stringify(second);
    expect(() => parseTierCCorpus(lines.join("\n"))).toThrow(/duplicate query/i);
    lines[1] = readFileSync(CORPUS, "utf8").trim().split("\n")[1]!;
    first.turns[0]!.ageHours = -1;
    lines[0] = JSON.stringify(first);
    expect(() => parseTierCCorpus(lines.join("\n"))).toThrow(/age/i);
  });

  test("evaluates selected turns, not the full source text", async () => {
    const encoder: BiEncoder = {
      dimension: 2,
      encode: async (texts) => texts.map((text) => (text === "query" || text.includes("noise") ? v(1, 0) : v(0, 1))),
    };
    const result = await runTierC(
      [
        {
          id: "tc-selected",
          scenario: "selection",
          query: "query",
          golden: { contains: ["required"], notContains: ["noise"], critical: true },
          turns: [
            { text: "required", ageHours: 80 },
            { text: "noise", ageHours: 1 },
            { text: "unrelated", ageHours: 2 },
          ],
        },
      ],
      encoder,
    );
    expect(result.total).toBe(1);
    expect(result.failedIds).toEqual(["tc-selected"]);
    expect(result.results[0]?.selectedIndices.length).toBeLessThan(3);
  });
});
