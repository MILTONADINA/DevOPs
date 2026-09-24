/**
 * LongMemEval Tier-A accuracy gate (MANUAL — real ONNX encoder + real Claude judge).
 *
 * The second long-horizon benchmark's JUDGED gate (after eval:locomo), feeding the
 * COMPLETE gate (ADR-0016: degradation-dominant metrics + evidence-survival co-gate).
 * Each LongMemEval question carries its OWN haystack, so a scenario == a question.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:longmemeval
 *
 * Cost-bounded + SAMPLED:
 *   LONGMEMEVAL_QUESTIONS         questions to sample                 (default 8)
 *   LONGMEMEVAL_TYPES             CSV of question types to include    (default: all)
 *   LONGMEMEVAL_LAMBDAS           CSV of λ; FIRST is the GATE          (default 0.97)
 *   LONGMEMEVAL_DECAY_HORIZON_FRAC  scale-invariant decay = frac×span (default 0 = per-hour)
 *   LONGMEMEVAL_REPEATS           judge samples per context          (default 1)
 *
 * Honesty contract (as eval:locomo): never fabricates a PASS; a FAIL is a real
 * finding; gold answers are NOT used to tune λ (evidence survival is deterministic).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, halfLifeHours } from "../src/pruner/kadanedial";
import { createClaudeAnswerer, createLlmJudge, selectEvalProvider } from "../evals/harness/metrics";
import { scoreLongMemContexts } from "../evals/harness/longmemeval-scoring";
import { gateScenario } from "../evals/harness/compare";
import { evaluateSuite, renderReport } from "../evals/harness/report";
import { DEFAULT_THRESHOLDS, type MetricScores, type ScenarioResult } from "../evals/harness/types";
import { planFullLongMemEval } from "../evals/harness/published-coverage";
import { loadLongMemEval, sampleLongMemQuestions, renderLongMemTurns, type LongMemQuestion } from "../evals/harness/longmemeval";

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function envFloat(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function envFloatList(name: string, def: number[]): number[] {
  const v = process.env[name];
  if (!v) return def;
  const out = v.split(",").map((s) => Number.parseFloat(s.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 1);
  return out.length ? out : def;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function fmt(n: number): string {
  return n.toFixed(3);
}

interface QOutcome {
  q: LongMemQuestion;
  reductionPct: number;
  evidenceSurvival: number | undefined;
  pruned: MetricScores;
  baseline: MetricScores;
  prunedStd: MetricScores;
  baselineStd: MetricScores;
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const full = process.env["EVAL_FULL_PUBLISHED"] === "1";
  const dir = join(process.cwd(), "evals", "datasets", "longmemeval");
  const haystack = join(dir, "longmemeval_s.json");
  const oracle = join(dir, "longmemeval_oracle.json");
  const file = existsSync(haystack) ? haystack : existsSync(oracle) ? oracle : null;
  const provider = selectEvalProvider();
  if (!file || !provider) {
    out("LongMemEval Tier-A gate — GATED (an input is missing; not run)");
    out("==============================================================");
    out(`  longmemeval data:  ${file ? `yes (${file.endsWith("longmemeval_s.json") ? "haystack" : "oracle"})` : "NO  (evals/datasets/longmemeval/longmemeval_s.json — MIT, HF xiaowu0162/longmemeval-cleaned)"}`);
    out(`  eval provider:     ${provider ? provider.label : "NO (set EVAL_ANTHROPIC_API_KEY or EVAL_LOCAL_BASE_URL + EVAL_LOCAL_MODEL)"}`);
    out("Refusing to emit fabricated scores. Exiting 1.");
    return 1;
  }
  if (full && file !== haystack) {
    out("Full LongMemEval requires the 500-question haystack, not the evidence-only oracle.");
    return 1;
  }
  const isOracle = file === oracle;

  const nQ = full ? 500 : envInt("LONGMEMEVAL_QUESTIONS", 8);
  const lambdas = full ? [DEFAULT_KADANEDIAL.lambda] : envFloatList("LONGMEMEVAL_LAMBDAS", [DEFAULT_KADANEDIAL.lambda]);
  const gateLambda = lambdas[0]!;
  const horizonFrac = full ? 0 : envFloat("LONGMEMEVAL_DECAY_HORIZON_FRAC", 0);
  const repeats = envInt("LONGMEMEVAL_REPEATS", 1);
  const typesEnv = process.env["LONGMEMEVAL_TYPES"];
  const types = full ? undefined : typesEnv ? typesEnv.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const loaded = loadLongMemEval(file);
  const coverage = full ? planFullLongMemEval(loaded) : undefined;
  const questions = coverage?.questions ?? sampleLongMemQuestions(loaded, types ? { maxQuestions: nQ, types } : { maxQuestions: nQ });
  const callBudget = questions.length * 4 * repeats; // R × baseline and pruned answer+judge cycles

  out(`CQ Eval Suite — Tier-A LongMemEval (real ONNX encoder + ${provider.label} judge${provider.exploratory ? "; EXPLORATORY local-model result" : ""})`);
  out("=".repeat(68));
  out(`Source: ${isOracle ? "oracle (evidence-only — degenerate for pruning)" : "haystack longmemeval_s.json"}   Questions: ${questions.length}${types ? ` (types ${types.join(",")})` : ""}`);
  if (coverage) out(`Full coverage: selected ${coverage.selected}/500; evidence-labeled ${coverage.labeled}; unlabeled ${coverage.unlabeled}.`);
  out(
    `GATE λ = ${gateLambda} (${horizonFrac > 0 ? `half-life ${((horizonFrac * -1) / Math.log2(gateLambda)).toFixed(2)}×span` : `half-life ${halfLifeHours(gateLambda).toFixed(1)}h`})   Decay: ${horizonFrac > 0 ? `SCALE-INVARIANT ${horizonFrac}×span (ADR-0015)` : "absolute per-hour"}`,
  );
  out(`Thresholds: Faithfulness ≥ ${DEFAULT_THRESHOLDS.faithfulnessMin}, Answer-Relevancy ≥ ${DEFAULT_THRESHOLDS.answerRelevancyMin}, max degradation ${DEFAULT_THRESHOLDS.maxDegradation}, evidence survival ≥ ${DEFAULT_THRESHOLDS.evidenceSurvivalMin}`);
  out(`Upper-bound model calls: ${callBudget} (${provider.label}).`);
  out(repeats > 1 ? `Judge sampling: R=${repeats} repeats/context, averaged` : "Judge sampling: single shot (set LONGMEMEVAL_REPEATS>1 to damp noise)");
  out("");

  if (questions.length === 0) {
    out("No questions evaluated. Exiting 1 (empty Tier-A selection).");
    return 1;
  }

  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const answerer = createClaudeAnswerer(provider.completion);
  const judge = createLlmJudge(provider.completion);

  const outcomes: QOutcome[] = [];
  for (const q of questions) {
    if (q.turns.length < 2) continue;
    const turnVecs = await encoder.encode(q.turns.map((t) => t.text));
    const [queryVec] = await encoder.encode([q.query]);
    if (!queryVec) continue;
    const first = q.turns[0]!.timestampSeconds;
    const last = q.turns[q.turns.length - 1]!.timestampSeconds;
    const span = Math.max(1, last - first);
    const nowSeconds = last + 3600;
    const horizon = horizonFrac > 0 ? { decayHorizonSeconds: horizonFrac * span } : {};
    const history: HistoryEmbedding[] = q.turns.map((t, i) => ({ embedding: turnVecs[i]!, timestampSeconds: t.timestampSeconds }));

    const fullText = renderLongMemTurns(q.turns);
    const decision = prune(queryVec, history, { lambda: gateLambda, gainShift: DEFAULT_KADANEDIAL.gainShift, theta: DEFAULT_KADANEDIAL.theta, nowSeconds, ...horizon });
    const sel = decision.selectedIndices;
    const selSet = new Set(sel);
    const prunedText = renderLongMemTurns(q.turns, sel);
    const reductionPct = fullText.length ? Math.round((1 - prunedText.length / fullText.length) * 100) : 0;
    const evidenceSurvival = q.evidenceIndices.length ? q.evidenceIndices.filter((i) => selSet.has(i)).length / q.evidenceIndices.length : undefined;

    const scores = await scoreLongMemContexts(q.query, fullText, prunedText, answerer, judge, repeats);
    const { mean: pruned, std: prunedStd } = scores.pruned;
    const { mean: baseline, std: baselineStd } = scores.baseline;
    outcomes.push({ q, reductionPct, evidenceSurvival, pruned, baseline, prunedStd, baselineStd });
    out(
        `  [${q.questionType.padEnd(26)}] kept ${sel.length}/${q.turns.length} (-${reductionPct}%)  evid ${evidenceSurvival === undefined ? "unlabeled" : `${(evidenceSurvival * 100).toFixed(0)}%`}  ` +
        `faith ${fmt(pruned.faithfulness)}/${fmt(baseline.faithfulness)}  relev ${fmt(pruned.answerRelevancy)}/${fmt(baseline.answerRelevancy)}`,
    );
  }

  if (outcomes.length === 0) {
    out("No questions evaluated. Exiting 1 (no scored Tier-A outcomes).");
    return 1;
  }
  if (coverage) out(`Full coverage scored: ${outcomes.length}/${coverage.selected}; evidence-labeled ${coverage.labeled}; unlabeled ${coverage.unlabeled}.`);
  if (full && outcomes.length !== questions.length) {
    out(`Full LongMemEval incomplete: scored ${outcomes.length}/${questions.length} selected questions.`);
    return 1;
  }

  const scenarioResults: ScenarioResult[] = outcomes.map((o, i) => ({
    tier: "A",
    name: `${o.q.questionType}#${i}`,
    pruned: o.pruned,
    baseline: o.baseline,
    ...(o.evidenceSurvival === undefined ? {} : { evidenceSurvival: o.evidenceSurvival }),
  }));
  const scenarios = scenarioResults.map((r) => gateScenario(r, DEFAULT_THRESHOLDS));
  const suite = { scenarios, golden: [] };
  const verdict = evaluateSuite(suite);

  out("");
  out(renderReport(suite, verdict));
  out("");
  out("Aggregate (gate config):");
  out(`  Faithfulness    pruned ${fmt(mean(outcomes.map((o) => o.pruned.faithfulness)))}  baseline ${fmt(mean(outcomes.map((o) => o.baseline.faithfulness)))}`);
  out(`  AnswerRelevancy pruned ${fmt(mean(outcomes.map((o) => o.pruned.answerRelevancy)))}  baseline ${fmt(mean(outcomes.map((o) => o.baseline.answerRelevancy)))}`);
  const labeledSurvival = outcomes.map((o) => o.evidenceSurvival).filter((value): value is number => value !== undefined);
  out(`  Evidence survival ${labeledSurvival.length ? `${(mean(labeledSurvival) * 100).toFixed(1)}%` : "unavailable"} (${labeledSurvival.length}/${outcomes.length} labeled)   mean context reduction ${Math.round(mean(outcomes.map((o) => o.reductionPct)))}%`);
  if (repeats > 1) {
    out(`  Judge noise (R=${repeats}, mean per-scenario std): faith pruned ${fmt(mean(outcomes.map((o) => o.prunedStd.faithfulness)))} / baseline ${fmt(mean(outcomes.map((o) => o.baselineStd.faithfulness)))}, relev pruned ${fmt(mean(outcomes.map((o) => o.prunedStd.answerRelevancy)))} / baseline ${fmt(mean(outcomes.map((o) => o.baselineStd.answerRelevancy)))}`);
  }
  out(`  Scenarios passing the COMPLETE gate: ${scenarios.filter((s) => s.passed).length}/${scenarios.length}`);
  out("");
  out(`${provider.exploratory ? "EXPLORATORY " : ""}${verdict.passed ? "PASS" : "FAIL"} — Tier-A LongMemEval ${provider.exploratory ? "local-model check" : "gate"} (${full ? "full" : "sampled"}).`);
  if (provider.exploratory) out("Local-model results do not satisfy the documented Claude Haiku release gate; published benchmark coverage remains open.");
  if (isOracle) out("NOTE: oracle is evidence-only (little to prune) — run on longmemeval_s.json for the real pruning signal.");
  return verdict.passed && (!full || !provider.exploratory) ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-longmemeval.ts") || entryPath.endsWith("eval-longmemeval.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      // Clean exit on a runtime/API error (e.g. depleted API credits) — not an
      // unhandled rejection (which crashes with a libuv assertion + exit 9).
      process.stderr.write(`eval-longmemeval failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
