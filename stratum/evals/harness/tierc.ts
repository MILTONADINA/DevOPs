/** Deterministic Tier-C golden gate over the real encoder and pruner. */
import { readFileSync } from "node:fs";
import type { BiEncoder } from "../../src/pruner/encoder";
import { prune } from "../../src/pruner/pruner";
import { DEFAULT_KADANEDIAL } from "../../src/pruner/kadanedial";
import { parseDevScenarios, toGoldenQuery, type DevScenario } from "./dataset";
import { checkGoldenQuery } from "./golden";
import type { GoldenResult } from "./types";

const NOW_SECONDS = 1_700_000_000;

/** Refuse a small, duplicate, or vacuous authored corpus before it can pass. */
export function parseTierCCorpus(jsonl: string): DevScenario[] {
  const cases = parseDevScenarios(jsonl);
  if (cases.length < 50) throw new Error(`Tier-C requires at least 50 critical cases; found ${cases.length}`);
  const ids = new Set<string>();
  const queries = new Set<string>();
  for (const entry of cases) {
    if (ids.has(entry.id)) throw new Error(`Tier-C duplicate id: ${entry.id}`);
    ids.add(entry.id);
    const queryKey = entry.query.trim().toLowerCase();
    if (queries.has(queryKey)) throw new Error(`Tier-C duplicate query: ${entry.query}`);
    queries.add(queryKey);
    if (!entry.golden.critical || entry.query.trim() === "" || entry.turns.length < 3 || entry.golden.contains.length === 0 || entry.golden.notContains.length === 0) {
      throw new Error(`Tier-C ${entry.id}: critical query, 3 turns, and required/forbidden anchors are mandatory`);
    }
    const full = entry.turns.map((turn) => turn.text).join("\n");
    if (entry.turns.some((turn) => !Number.isFinite(turn.ageHours) || turn.ageHours < 0)) throw new Error(`Tier-C ${entry.id}: invalid turn age`);
    for (const anchor of [...entry.golden.contains, ...entry.golden.notContains]) {
      if (anchor === "" || !full.includes(anchor)) throw new Error(`Tier-C ${entry.id}: anchor absent from source turns`);
    }
  }
  return cases;
}

export function loadTierCCorpus(file: string): DevScenario[] {
  return parseTierCCorpus(readFileSync(file, "utf8"));
}

export interface TierCResult {
  total: number;
  passed: number;
  failedIds: string[];
  results: Array<{ id: string; selectedIndices: number[]; golden: GoldenResult }>;
}

/** Encode each real query/turn and check only the selected context. */
export async function runTierC(cases: DevScenario[], encoder: BiEncoder): Promise<TierCResult> {
  const results: TierCResult["results"] = [];
  for (const entry of cases) {
    const texts = entry.turns.map((turn) => turn.text);
    const vectors = await encoder.encode([...texts, entry.query]);
    if (vectors.length !== texts.length + 1 || !vectors[texts.length]) throw new Error(`Tier-C ${entry.id}: encoder returned incomplete vectors`);
    const decision = prune(
      vectors[texts.length]!,
      entry.turns.map((turn, index) => ({ embedding: vectors[index]!, timestampSeconds: NOW_SECONDS - turn.ageHours * 3600 })),
      { ...DEFAULT_KADANEDIAL, nowSeconds: NOW_SECONDS },
    );
    const selected = decision.selectedIndices.map((index) => texts[index]!).join("\n");
    results.push({ id: entry.id, selectedIndices: decision.selectedIndices, golden: checkGoldenQuery(selected, toGoldenQuery(entry)) });
  }
  const failedIds = results.filter((entry) => !entry.golden.passed).map((entry) => entry.id);
  return { total: results.length, passed: results.length - failedIds.length, failedIds, results };
}
