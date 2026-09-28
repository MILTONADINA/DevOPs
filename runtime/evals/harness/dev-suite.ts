/**
 * Dev-suite pipeline (Phase 2 / v0.4.x) — run Tier-B scenarios through the REAL
 * pruner end-to-end: encode turns + query → KadaneDial prune() → answer pruned
 * vs full → judge → gate + golden. Used by `npm run eval:tierb` and the runner.
 *
 * Deterministic inputs (encoder/answerer/judge + nowSeconds) are injected so the
 * orchestration is testable with fakes; the real run wires the ONNX encoder +
 * Claude answerer/judge.
 */

import type { BiEncoder } from "../../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams, type PruneDecision } from "../../src/pruner/kadanedial";
import type { Answerer, Judge } from "./metrics";
import { runScenario } from "./runner";
import { gateScenario, type ScenarioVerdict } from "./compare";
import { checkGoldenQuery } from "./golden";
import { evaluateSuite, type SuiteResult, type SuiteVerdict } from "./report";
import { DEFAULT_THRESHOLDS, type MetricThresholds, type ScenarioResult } from "./types";
import { toGoldenQuery, type DevScenario } from "./dataset";

export interface DevScenarioOutcome {
  scenario: DevScenario;
  decision: PruneDecision;
  prunedText: string;
  fullText: string;
  reductionPct: number;
  result: ScenarioResult;
}

export type DialParams = Omit<KadaneDialParams, "nowSeconds">;
const DEFAULT_DIAL: DialParams = { lambda: DEFAULT_KADANEDIAL.lambda, gainShift: DEFAULT_KADANEDIAL.gainShift, theta: DEFAULT_KADANEDIAL.theta };

/** Run one Tier-B scenario through encode → prune → answer → judge. */
export async function runDevScenario(
  scn: DevScenario,
  encoder: BiEncoder,
  answerer: Answerer,
  judge: Judge,
  nowSeconds: number,
  dial: DialParams = DEFAULT_DIAL,
): Promise<DevScenarioOutcome> {
  const turnTexts = scn.turns.map((t) => t.text);
  const vecs = await encoder.encode([...turnTexts, scn.query]);
  const queryVec = vecs[vecs.length - 1];
  if (!queryVec) throw new Error(`scenario ${scn.id}: query failed to encode`);
  const history: HistoryEmbedding[] = scn.turns.map((t, i) => ({
    embedding: vecs[i]!,
    timestampSeconds: nowSeconds - t.ageHours * 3600,
  }));
  const decision = prune(queryVec, history, { ...dial, nowSeconds });
  const prunedText = decision.selectedIndices.map((i) => turnTexts[i]!).join("\n");
  const fullText = turnTexts.join("\n");
  const result = await runScenario(
    { tier: "B", name: scn.scenario, query: scn.query, fullContext: fullText, prune: () => prunedText },
    answerer,
    judge,
  );
  const reductionPct = fullText.length ? Math.round((1 - prunedText.length / fullText.length) * 100) : 0;
  return { scenario: scn, decision, prunedText, fullText, reductionPct, result };
}

export interface DevSuiteOutput {
  suite: SuiteResult;
  verdict: SuiteVerdict;
  outcomes: DevScenarioOutcome[];
}

/** Run all Tier-B scenarios + aggregate into a gated suite verdict. */
export async function runDevSuite(
  scns: DevScenario[],
  encoder: BiEncoder,
  answerer: Answerer,
  judge: Judge,
  nowSeconds: number,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
  dial: DialParams = DEFAULT_DIAL,
): Promise<DevSuiteOutput> {
  const scenarios: ScenarioVerdict[] = [];
  const golden = [];
  const outcomes: DevScenarioOutcome[] = [];
  for (const scn of scns) {
    const o = await runDevScenario(scn, encoder, answerer, judge, nowSeconds, dial);
    scenarios.push(gateScenario(o.result, thresholds));
    golden.push(checkGoldenQuery(o.prunedText, toGoldenQuery(scn)));
    outcomes.push(o);
  }
  const suite: SuiteResult = { scenarios, golden };
  return { suite, verdict: evaluateSuite(suite), outcomes };
}
