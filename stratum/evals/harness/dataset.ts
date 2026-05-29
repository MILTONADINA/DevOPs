/**
 * Tier-B developer-workload dataset loader (Phase 2 / v0.4.x).
 *
 * Tier-B is "synthetic but realistic" per docs/EVAL_FRAMEWORK.md — multi-turn
 * dialogues, each with one answer-critical fact buried among noise, plus a query
 * and golden expectations. Stored as JSONL in evals/datasets/developer/. The
 * loader is pure (no model, no API) and unit-tested.
 */

import { readFileSync } from "node:fs";

export interface DevTurn {
  /** The turn's text (user input / decision / tool output). */
  text: string;
  /** How long ago the turn occurred, in hours (→ timestamp via nowSeconds). */
  ageHours: number;
}

export interface DevGolden {
  /** Substrings that MUST survive into the pruned context. */
  contains: string[];
  /** Substrings that must NOT survive (e.g. another project's identifiers). */
  notContains: string[];
  critical: boolean;
}

export interface DevScenario {
  id: string;
  scenario: string;
  query: string;
  golden: DevGolden;
  turns: DevTurn[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Parse + validate Tier-B JSONL (one scenario per non-empty line). */
export function parseDevScenarios(jsonl: string): DevScenario[] {
  const out: DevScenario[] = [];
  let lineNo = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    lineNo++;
    if (line.trim() === "") continue;
    const o = JSON.parse(line) as Partial<DevScenario> & { golden?: Partial<DevGolden> };
    if (typeof o.id !== "string" || typeof o.query !== "string" || !Array.isArray(o.turns)) {
      throw new Error(`tier-b line ${lineNo}: missing id/query/turns`);
    }
    const g: Partial<DevGolden> = o.golden ?? {};
    if (!isStringArray(g.contains) || !isStringArray(g.notContains) || typeof g.critical !== "boolean") {
      throw new Error(`tier-b line ${lineNo} (${o.id}): malformed golden`);
    }
    const turns: DevTurn[] = o.turns.map((t, i) => {
      const tt = t as Partial<DevTurn>;
      if (typeof tt.text !== "string" || typeof tt.ageHours !== "number") {
        throw new Error(`tier-b line ${lineNo} (${o.id}): turn ${i} missing text/ageHours`);
      }
      return { text: tt.text, ageHours: tt.ageHours };
    });
    out.push({ id: o.id, scenario: o.scenario ?? o.id, query: o.query, golden: { contains: g.contains, notContains: g.notContains, critical: g.critical }, turns });
  }
  return out;
}

/** Load Tier-B scenarios from a JSONL file. */
export function loadDevScenarios(file: string): DevScenario[] {
  return parseDevScenarios(readFileSync(file, "utf8"));
}

/** Convert a scenario's golden spec into the engine's {@link import("./types").GoldenQuery}. */
export function toGoldenQuery(scn: DevScenario): {
  id: string;
  scenario: string;
  query: string;
  expectedContains: string[];
  expectedNotContains: string[];
  critical: boolean;
} {
  return {
    id: scn.id,
    scenario: scn.scenario,
    query: scn.query,
    expectedContains: scn.golden.contains,
    expectedNotContains: scn.golden.notContains,
    critical: scn.golden.critical,
  };
}
