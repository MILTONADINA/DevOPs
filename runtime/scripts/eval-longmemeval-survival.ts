/**
 * LongMemEval evidence-survival sweep (FREE — no judge/answerer, no API).
 *
 * The SECOND long-horizon benchmark's free, deterministic check that the decay
 * calibration (ADR-0015) generalizes beyond LoCoMo (guards against over-fitting,
 * PB-41). Evidence survival = gold-evidence turns (has_answer) ∩ the pruner's
 * selection — needs the local ONNX encoder but NO Claude calls.
 *
 * Uses the haystack set (longmemeval_s.json) when present — that has filler
 * sessions to prune; the oracle set (evidence-only) is a degenerate pruning test
 * and is only a fallback. Compares ABSOLUTE per-hour decay vs SCALE-INVARIANT
 * decay (h·span), exactly as scripts/eval-locomo-survival.ts.
 *
 *   npm run eval:longmemeval:survival
 *   LONGMEMEVAL_QUESTIONS=40 npm run eval:longmemeval:survival
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams } from "../src/pruner/kadanedial";
import { loadLongMemEval, sampleLongMemQuestions, renderLongMemTurns } from "../evals/harness/longmemeval";

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

type Config = { label: string; build: (spanSeconds: number) => Omit<KadaneDialParams, "nowSeconds"> };
const G = DEFAULT_KADANEDIAL.gainShift;
const T = DEFAULT_KADANEDIAL.theta;
const CONFIGS: Config[] = [
  { label: "abs  λ=0.97 (DEFAULT, per-hour)", build: () => ({ lambda: 0.97, gainShift: G, theta: T }) },
  { label: "abs  λ=0.999 (per-hour)", build: () => ({ lambda: 0.999, gainShift: G, theta: T }) },
  { label: "abs  λ=1.0 (no decay)", build: () => ({ lambda: 1.0, gainShift: G, theta: T }) },
  { label: "span h=1.00·span", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: s }) },
  { label: "span h=0.50·span", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: 0.5 * s }) },
  { label: "span h=0.25·span", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: 0.25 * s }) },
];

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const dir = join(process.cwd(), "evals", "datasets", "longmemeval");
  const haystack = join(dir, "longmemeval_s.json");
  const oracle = join(dir, "longmemeval_oracle.json");
  const file = existsSync(haystack) ? haystack : existsSync(oracle) ? oracle : null;
  if (!file) {
    out("GATED: no LongMemEval data (evals/datasets/longmemeval/longmemeval_s.json — MIT, fetch from HF xiaowu0162/longmemeval-cleaned). Exiting 0.");
    return 0;
  }
  const isOracle = file === oracle;

  const perN = envInt("LONGMEMEVAL_QUESTIONS", 30);
  const questions = sampleLongMemQuestions(loadLongMemEval(file), { maxQuestions: perN });
  out("LongMemEval evidence-survival sweep (FREE — local ONNX only, no judge/API)");
  out("=".repeat(72));
  out(`Source: ${isOracle ? "longmemeval_oracle.json (EVIDENCE-ONLY — degenerate for pruning; haystack _s preferred)" : "longmemeval_s.json (haystack with filler)"}`);
  out(`Questions: ${questions.length} (each carries its OWN haystack; gold evidence = has_answer turns)`);
  out("");

  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const rows = new Map<string, { survival: number[]; reduction: number[] }>();
  for (const c of CONFIGS) rows.set(c.label, { survival: [], reduction: [] });

  let done = 0;
  for (const q of questions) {
    if (q.evidenceIndices.length === 0 || q.turns.length < 2) continue;
    const turnVecs = await encoder.encode(q.turns.map((t) => t.text));
    const [queryVec] = await encoder.encode([q.query]);
    if (!queryVec) continue;
    const first = q.turns[0]!.timestampSeconds;
    const last = q.turns[q.turns.length - 1]!.timestampSeconds;
    const span = Math.max(1, last - first);
    const nowSeconds = last + 3600;
    const history: HistoryEmbedding[] = q.turns.map((t, i) => ({ embedding: turnVecs[i]!, timestampSeconds: t.timestampSeconds }));
    for (const cfg of CONFIGS) {
      const decision = prune(queryVec, history, { ...cfg.build(span), nowSeconds });
      const sel = new Set(decision.selectedIndices);
      const survived = q.evidenceIndices.filter((i) => sel.has(i)).length / q.evidenceIndices.length;
      const reduction = 1 - decision.selectedIndices.length / q.turns.length;
      const row = rows.get(cfg.label)!;
      row.survival.push(survived);
      row.reduction.push(reduction);
    }
    done++;
    if (done % 10 === 0) out(`  …${done}/${questions.length} questions encoded`);
  }
  void renderLongMemTurns; // (available for a judged runner; survival needs only indices)

  out("");
  out(`config                                      evid-survival   ctx-reduction   (n=${done})`);
  out("-".repeat(76));
  for (const cfg of CONFIGS) {
    const r = rows.get(cfg.label)!;
    out(`  ${cfg.label.padEnd(42)}  ${pct(mean(r.survival)).padStart(8)}      ${pct(mean(r.reduction)).padStart(8)}`);
  }
  out("");
  out("Cross-check vs LoCoMo (ADR-0015): if scale-invariant 'span h=…' again recovers evidence");
  out("survival over absolute λ=0.97, the tier-aware-decay finding GENERALIZES (not LoCoMo-specific).");
  if (isOracle) out("NOTE: oracle is evidence-only (little to prune) — rerun on longmemeval_s.json for the real signal.");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-longmemeval-survival.ts") || entryPath.endsWith("eval-longmemeval-survival.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
