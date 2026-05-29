/**
 * KadaneDial parameter sweep (θ × λ) over Tier-B — calibration DATA, not a
 * tuned-to-pass knob. Encodes each scenario ONCE (real ONNX encoder) then runs
 * prune() + the DETERMINISTIC golden check for every (θ, λ) cell — NO judge/API
 * (golden contains/notContains is substring matching on the pruned context, so
 * it captures both failure directions: dropped fact = contains-miss, kept noise
 * = notContains-leak). Reports the pass-rate matrix + the tradeoff.
 *
 * Honest framing: this CHARACTERIZES the parameter space on the synthetic dev
 * set to inform calibration; it does NOT commit a tuned default (that requires
 * the published Tier-A datasets — over-fitting 11 synthetic scenarios would lie).
 *
 *   npm run sweep-params
 */

import { join } from "node:path";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL } from "../src/pruner/kadanedial";
import { loadDevScenarios, toGoldenQuery, type DevScenario } from "../evals/harness/dataset";
import { checkGoldenQuery } from "../evals/harness/golden";

const NOW = 1_700_000_000;
const THETAS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5];
const LAMBDAS = [0.97, 0.9, 0.8];

interface Encoded {
  scenario: DevScenario;
  turnVecs: Float32Array[];
  queryVec: Float32Array;
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const file = join(process.cwd(), "evals", "datasets", "developer", "tier-b.jsonl");
  const scenarios = loadDevScenarios(file);
  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });

  out(`Encoding ${scenarios.length} scenarios once (real ONNX)…`);
  const encoded: Encoded[] = [];
  for (const s of scenarios) {
    const vecs = await encoder.encode([...s.turns.map((t) => t.text), s.query]);
    const queryVec = vecs[vecs.length - 1];
    if (!queryVec) continue;
    encoded.push({ scenario: s, turnVecs: vecs.slice(0, s.turns.length), queryVec });
  }

  // For each (λ, θ): count scenarios whose pruned context passes the golden check.
  const goldenPass = (e: Encoded, lambda: number, theta: number): boolean => {
    const history: HistoryEmbedding[] = e.scenario.turns.map((t, i) => ({
      embedding: e.turnVecs[i]!,
      timestampSeconds: NOW - t.ageHours * 3600,
    }));
    const decision = prune(e.queryVec, history, { lambda, gainShift: DEFAULT_KADANEDIAL.gainShift, theta, nowSeconds: NOW });
    const prunedText = decision.selectedIndices.map((i) => e.scenario.turns[i]!.text).join("\n");
    return checkGoldenQuery(prunedText, toGoldenQuery(e.scenario)).passed;
  };

  out("");
  out(`Golden pass-rate over ${encoded.length} scenarios (rows=λ, cols=θ):`);
  out(`        ${THETAS.map((t) => `θ=${t}`.padStart(7)).join("")}`);
  let best = { lambda: 0, theta: 0, pass: -1 };
  for (const lambda of LAMBDAS) {
    const cells: string[] = [];
    for (const theta of THETAS) {
      const pass = encoded.filter((e) => goldenPass(e, lambda, theta)).length;
      cells.push(`${pass}/${encoded.length}`.padStart(7));
      if (pass > best.pass) best = { lambda, theta, pass };
    }
    out(`λ=${lambda.toFixed(2)}  ${cells.join("")}`);
  }
  out("");
  out(`Default (λ=${DEFAULT_KADANEDIAL.lambda}, θ=${DEFAULT_KADANEDIAL.theta}): ${encoded.filter((e) => goldenPass(e, DEFAULT_KADANEDIAL.lambda, DEFAULT_KADANEDIAL.theta)).length}/${encoded.length}`);
  out(`Best cell on this dev set: λ=${best.lambda}, θ=${best.theta} → ${best.pass}/${encoded.length}`);

  // Per-scenario pass under the best cell (which scenarios still fail there).
  const fails = encoded.filter((e) => !goldenPass(e, best.lambda, best.theta)).map((e) => e.scenario.id);
  out(`At the best cell, still failing: ${fails.length ? fails.join(", ") : "(none)"}`);
  out("");
  out("DATA ONLY — characterizes the synthetic dev set to inform calibration. NOT a");
  out("committed default: real λ/θ tuning requires the published Tier-A datasets;");
  out("over-fitting 11 synthetic scenarios would not generalize.");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("sweep-params.ts") || entryPath.endsWith("sweep-params.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
