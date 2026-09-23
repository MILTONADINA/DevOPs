/**
 * LoCoMo Tier-A accuracy gate (MANUAL — real ONNX encoder + real Claude judge).
 *
 * Runs the PUBLISHED LoCoMo long-term-memory benchmark through the REAL pruning
 * pipeline (encode → KadaneDial prune → answer pruned vs full → judge → gate),
 * which is the constitution's ship gate for pruning: <5% Faithfulness AND <5%
 * Answer-Relevancy degradation vs the full-context baseline (stratum CLAUDE.md
 * "Eval Before Ship" + docs/EVAL_FRAMEWORK.md). LoCoMo's multi-WEEK horizon is
 * exactly what stresses the temporal-decay λ.
 *
 *   ANTHROPIC_API_KEY=... npm run eval:locomo
 *
 * Cost is bounded + SAMPLED (we told the operator we'd keep API spend low):
 *   LOCOMO_CONVERSATIONS  how many of the 10 conversations to use   (default 2)
 *   LOCOMO_QUESTIONS      answerable questions per conversation      (default 6)
 *   LOCOMO_CATEGORIES     CSV of LoCoMo categories                   (default 1,2,3,4)
 *   LOCOMO_LAMBDAS        CSV of λ to characterize; FIRST is the GATE (default 0.97)
 *   LOCOMO_JUDGE_MODEL    judge/answerer model                       (default Claude Haiku)
 *
 * Honesty contract (stratum CLAUDE.md / blueprint): this NEVER fabricates a
 * PASS. A FAIL is a real finding — most likely that the documented λ=0.97/hour
 * (≈22.7h half-life) is calibrated for intra-day coding sessions and decays
 * LoCoMo's weeks-old evidence to ~0. The fix is calibration/supersession, NOT
 * shipping pruning. Gold answers are NOT used to tune anything (over-fitting is
 * forbidden); they would only ever be a reported reference signal.
 */

import "dotenv/config";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, halfLifeHours } from "../src/pruner/kadanedial";
import { createClaudeAnswerer, createLlmJudge, scoreContextRepeated, type Answerer, type Judge } from "../evals/harness/metrics";
import { summarizeScores } from "../evals/harness/aggregate";
import { gateScenario } from "../evals/harness/compare";
import { evaluateSuite, renderReport } from "../evals/harness/report";
import { DEFAULT_THRESHOLDS, type MetricScores, type ScenarioResult } from "../evals/harness/types";
import {
  loadLocomo,
  sampleQuestions,
  resolveEvidence,
  renderTurns,
  type LocomoConversation,
  type LocomoQuestion,
} from "../evals/harness/locomo";

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
function envIntList(name: string, def: number[]): number[] {
  const v = process.env[name];
  if (!v) return def;
  const out = v.split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  return out.length ? out : def;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function fmt(n: number): string {
  return n.toFixed(3);
}

interface LambdaOutcome {
  lambda: number;
  selectedIndices: number[];
  prunedText: string;
  reductionPct: number;
  /** evidence turns that survived pruning / total resolved evidence turns. */
  evidenceSurvival: number;
  /** Mean pruned scores over the R repeats (the noise-damped point estimate). */
  pruned: MetricScores;
  /** Per-metric sample std of the pruned scores across the R repeats (judge noise; PB-42). */
  prunedStd: MetricScores;
}

interface QuestionOutcome {
  conv: string;
  query: string;
  category: number;
  earliestSession: number;
  fullTurns: number;
  /** Mean baseline (full-context) scores over the R repeats. */
  baseline: MetricScores;
  /** Per-metric sample std of the baseline scores across the R repeats. */
  baselineStd: MetricScores;
  byLambda: LambdaOutcome[];
}

/**
 * Evaluate one question across all λ, computing the full-context baseline ONCE
 * and caching pruned answer/judge by selection signature (so equal selections
 * across λ cost no extra API calls).
 */
export async function runQuestion(
  conv: LocomoConversation,
  q: LocomoQuestion,
  queryVec: Float32Array,
  turnVecs: Float32Array[],
  nowSeconds: number,
  lambdas: number[],
  answerer: Answerer,
  judge: Judge,
  decayHorizonSeconds?: number,
  repeats = 1,
): Promise<QuestionOutcome> {
  const fullText = renderTurns(conv.turns);
  const ev = resolveEvidence(conv, q);
  const earliestSession = ev.indices.length ? conv.turns[ev.indices[0]!]!.sessionIndex : 0;

  // Baseline (full context) — R repeats, averaged (PB-42 noise damping; R=1 ⇒ one cycle).
  const baseSummary = summarizeScores(await scoreContextRepeated(answerer, judge, q.query, fullText, repeats));
  const baseline = baseSummary.mean;

  const history: HistoryEmbedding[] = conv.turns.map((t, i) => ({ embedding: turnVecs[i]!, timestampSeconds: t.timestampSeconds }));
  // Cache the SUMMARY (mean+std) by selection signature so identical selections across
  // λ reuse the R samples — equal selection ⇒ no extra API cost even at R>1.
  const cache = new Map<string, ReturnType<typeof summarizeScores>>();
  const byLambda: LambdaOutcome[] = [];

  // Scale-invariant decay (ADR-0015) when a horizon is supplied; else per-hour λ.
  const horizon = decayHorizonSeconds && decayHorizonSeconds > 0 ? { decayHorizonSeconds } : {};
  for (const lambda of lambdas) {
    const decision = prune(queryVec, history, { lambda, gainShift: DEFAULT_KADANEDIAL.gainShift, theta: DEFAULT_KADANEDIAL.theta, nowSeconds, ...horizon });
    const sel = decision.selectedIndices;
    const selSet = new Set(sel);
    const prunedText = renderTurns(conv.turns, sel);
    const reductionPct = fullText.length ? Math.round((1 - prunedText.length / fullText.length) * 100) : 0;
    const survived = ev.indices.filter((i) => selSet.has(i)).length;
    const evidenceSurvival = ev.indices.length ? survived / ev.indices.length : 1;

    const sig = sel.join(",");
    let summary = cache.get(sig);
    if (!summary) {
      summary = summarizeScores(await scoreContextRepeated(answerer, judge, q.query, prunedText, repeats));
      cache.set(sig, summary);
    }
    byLambda.push({ lambda, selectedIndices: sel, prunedText, reductionPct, evidenceSurvival, pruned: summary.mean, prunedStd: summary.std });
  }

  return { conv: conv.sampleId, query: q.query, category: q.category, earliestSession, fullTurns: conv.turns.length, baseline, baselineStd: baseSummary.std, byLambda };
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  const file = join(process.cwd(), "evals", "datasets", "locomo", "locomo10.json");
  const haveData = existsSync(file);
  const haveKey = Boolean(process.env["ANTHROPIC_API_KEY"]);
  if (!haveData || !haveKey) {
    out("LoCoMo Tier-A gate — GATED (an input is missing; not run)");
    out("=========================================================");
    out(`  locomo10.json:  ${haveData ? "yes" : "NO  (evals/datasets/locomo/locomo10.json — CC-BY-NC, fetch from snap-research/locomo)"}`);
    out(`  judge API key:  ${haveKey ? "yes" : "NO  (set ANTHROPIC_API_KEY)"}`);
    out("Refusing to emit fabricated scores. Exiting 0.");
    return 0;
  }

  const nConv = envInt("LOCOMO_CONVERSATIONS", 2);
  const nQ = envInt("LOCOMO_QUESTIONS", 6);
  const cats = envIntList("LOCOMO_CATEGORIES", [1, 2, 3, 4]);
  const lambdas = envFloatList("LOCOMO_LAMBDAS", [DEFAULT_KADANEDIAL.lambda]);
  const gateLambda = lambdas[0]!;
  // ADR-0015 scale-invariant decay: when >0, decayHorizonSeconds = frac × the
  // conversation's own span (per-hour absolute decay otherwise). 0 = unset.
  const horizonFrac = envFloat("LOCOMO_DECAY_HORIZON_FRAC", 0);
  // PB-42 noise damping: score each scenario R times + average (judge/answerer are
  // stochastic; ADR-0015 saw baseline relevancy swing 0–1 at R=1). R=1 ⇒ single shot.
  const repeats = envInt("LOCOMO_REPEATS", 1);

  const conversations = loadLocomo(file).slice(0, nConv);
  const plan = conversations.map((c) => ({ c, qs: sampleQuestions(c, { maxQuestions: nQ, categories: cats }) }));
  const totalQ = plan.reduce((a, p) => a + p.qs.length, 0);
  const callBudget = totalQ * repeats * (2 + 2 * lambdas.length); // ×R repeats (PB-42); baseline + per-λ each (answer+judge)

  out("CQ Eval Suite — Tier-A LoCoMo (real ONNX encoder + Claude judge)");
  out("=".repeat(64));
  out(`Conversations: ${conversations.length}/10   Questions/conv: ${nQ} (cats ${cats.join(",")})   Sampled questions: ${totalQ}`);
  out(`λ characterized: [${lambdas.join(", ")}]   GATE λ = ${gateLambda} (half-life ${halfLifeHours(gateLambda).toFixed(1)}h)`);
  out(horizonFrac > 0 ? `Decay: SCALE-INVARIANT (ADR-0015) — horizon = ${horizonFrac}×span per conversation` : "Decay: absolute per-hour (documented default)");
  out(repeats > 1 ? `Judge sampling: R=${repeats} repeats/scenario, AVERAGED (PB-42 noise damping)` : "Judge sampling: single shot (set LOCOMO_REPEATS>1 to damp judge noise — ADR-0015/PB-42)");
  out(`Thresholds: Faithfulness ≥ ${DEFAULT_THRESHOLDS.faithfulnessMin}, Answer-Relevancy ≥ ${DEFAULT_THRESHOLDS.answerRelevancyMin}, max degradation ${DEFAULT_THRESHOLDS.maxDegradation}`);
  out(`Upper-bound model calls: ${callBudget} (Claude Haiku; pruned calls deduped by selection).`);
  out("Note: cat-5 (adversarial/unanswerable) is excluded — it tests refusal, not memory retention.");
  out("");

  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const answerer = createClaudeAnswerer();
  const judge = createLlmJudge();

  const outcomes: QuestionOutcome[] = [];
  for (const { c, qs } of plan) {
    if (qs.length === 0) {
      out(`  ${c.sampleId}: no eligible questions (filtered) — skipped.`);
      continue;
    }
    out(`→ ${c.sampleId}: ${c.turns.length} turns / ${c.questions.length} qa → encoding turns + ${qs.length} queries (real ONNX)…`);
    const lastTs = c.turns[c.turns.length - 1]?.timestampSeconds ?? 0;
    const firstTs = c.turns[0]?.timestampSeconds ?? 0;
    const nowSeconds = lastTs + 3600; // query asked ~1h after the last session
    const decayHorizonSeconds = horizonFrac > 0 ? horizonFrac * Math.max(1, lastTs - firstTs) : undefined;
    const turnVecs = await encoder.encode(c.turns.map((t) => t.text));
    const queryVecs = await encoder.encode(qs.map((q) => q.query));
    for (let i = 0; i < qs.length; i++) {
      const o = await runQuestion(c, qs[i]!, queryVecs[i]!, turnVecs, nowSeconds, lambdas, answerer, judge, decayHorizonSeconds, repeats);
      outcomes.push(o);
      const gl = o.byLambda[0]!;
      out(
        `    [cat${o.category} s${o.earliestSession}] kept ${gl.selectedIndices.length}/${o.fullTurns} (-${gl.reductionPct}%)  ` +
          `evid ${(gl.evidenceSurvival * 100).toFixed(0)}%  faith ${fmt(gl.pruned.faithfulness)}/${fmt(o.baseline.faithfulness)}  ` +
          `relev ${fmt(gl.pruned.answerRelevancy)}/${fmt(o.baseline.answerRelevancy)}  — ${o.query.slice(0, 50)}`,
      );
    }
  }

  if (outcomes.length === 0) {
    out("No questions evaluated. Exiting 0 (nothing to gate).");
    return 0;
  }

  // --- Gate on the FIRST λ (the documented shipping config). ---
  const scenarioResults: ScenarioResult[] = outcomes.map((o, i) => ({
    tier: "A",
    name: `${o.conv}#${i}`,
    pruned: o.byLambda[0]!.pruned,
    baseline: o.baseline,
    evidenceSurvival: o.byLambda[0]!.evidenceSurvival, // PB-39 co-gate (ADR-0016)
  }));
  const scenarios = scenarioResults.map((r) => gateScenario(r, DEFAULT_THRESHOLDS));
  const suite = { scenarios, golden: [] };
  const verdict = evaluateSuite(suite);

  out("");
  out(renderReport(suite, verdict));

  // --- Aggregate signals (gate λ). ---
  const gate = outcomes.map((o) => o.byLambda[0]!);
  const meanFaithP = mean(gate.map((g) => g.pruned.faithfulness));
  const meanFaithB = mean(outcomes.map((o) => o.baseline.faithfulness));
  const meanRelP = mean(gate.map((g) => g.pruned.answerRelevancy));
  const meanRelB = mean(outcomes.map((o) => o.baseline.answerRelevancy));
  out("");
  out("Aggregate (gate λ):");
  out(`  Faithfulness    pruned ${fmt(meanFaithP)}  baseline ${fmt(meanFaithB)}  degradation ${fmt(meanFaithB - meanFaithP)}`);
  out(`  AnswerRelevancy pruned ${fmt(meanRelP)}  baseline ${fmt(meanRelB)}  degradation ${fmt(meanRelB - meanRelP)}`);
  out(`  Evidence survival ${(mean(gate.map((g) => g.evidenceSurvival)) * 100).toFixed(1)}%   mean context reduction ${Math.round(mean(gate.map((g) => g.reductionPct)))}%`);
  out(`  Scenarios within threshold: ${scenarios.filter((s) => s.passed).length}/${scenarios.length}`);
  // Judge noise (PB-42): mean per-scenario sample std across the R repeats. A wide std at
  // the ship gate means the averaged mean is not yet trustworthy → raise LOCOMO_REPEATS.
  if (repeats > 1) {
    out(
      `  Judge noise (R=${repeats}, mean per-scenario std):  ` +
        `baseline Faith ±${fmt(mean(outcomes.map((o) => o.baselineStd.faithfulness)))} Relev ±${fmt(mean(outcomes.map((o) => o.baselineStd.answerRelevancy)))}  |  ` +
        `pruned Faith ±${fmt(mean(gate.map((g) => g.prunedStd.faithfulness)))} Relev ±${fmt(mean(gate.map((g) => g.prunedStd.answerRelevancy)))}`,
    );
  } else {
    out("  Judge noise: single sample/scenario — set LOCOMO_REPEATS>1 to damp (ADR-0015/PB-42).");
  }

  // --- λ characterization (when >1). ---
  if (lambdas.length > 1) {
    out("");
    out("λ sweep (evidence survival / context reduction / mean degradation) — characterization, NOT auto-tuning:");
    lambdas.forEach((lambda, li) => {
      const col = outcomes.map((o) => o.byLambda[li]!);
      const fDeg = mean(outcomes.map((o, k) => o.baseline.faithfulness - col[k]!.pruned.faithfulness));
      const rDeg = mean(outcomes.map((o, k) => o.baseline.answerRelevancy - col[k]!.pruned.answerRelevancy));
      out(
        `  λ=${lambda} (½-life ${halfLifeHours(lambda).toFixed(0)}h):  evid ${(mean(col.map((c) => c.evidenceSurvival)) * 100).toFixed(0)}%  ` +
          `reduction ${Math.round(mean(col.map((c) => c.reductionPct)))}%  ΔFaith ${fmt(fDeg)}  ΔRelev ${fmt(rDeg)}`,
      );
    });
  }

  out("");
  out(`${verdict.passed ? "PASS" : "FAIL"} — Tier-A LoCoMo gate (sampled, λ=${gateLambda}).`);
  if (!verdict.passed) {
    out(
      "A FAIL here is the EXPECTED finding if λ=0.97 crushes weeks-old evidence: do NOT ship pruning in the request path. " +
        "Remediation is calibration (a horizon-aware / near-1 λ for long-term memory) or supersession (ADR-0011), validated by re-running this gate — NOT tuning to gold (forbidden over-fitting).",
    );
  }
  return verdict.passed ? 0 : 1;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-locomo.ts") || entryPath.endsWith("eval-locomo.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      // Clean exit on a runtime/API error (e.g. depleted API credits) — not an
      // unhandled rejection (which crashes with a libuv assertion + exit 9).
      process.stderr.write(`eval-locomo failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
