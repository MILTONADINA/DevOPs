/**
 * LoCoMo evidence-survival sweep (FREE — no judge/answerer, no API).
 *
 * Evidence survival (gold `evidence` turns ∩ the pruner's selection) is a
 * DETERMINISTIC function of the prune decision alone — it needs the local ONNX
 * encoder but NO Claude calls. So this characterizes the decay model across the
 * WHOLE LoCoMo corpus at zero API cost, as the leading indicator for the
 * λ-horizon calibration (PB-38) the Tier-A gate (ADR-0014) demands.
 *
 * It compares ABSOLUTE per-hour decay (the documented λ=0.97, plus references)
 * against SCALE-INVARIANT decay — `decayHorizonSeconds = h · span`, where span is
 * each conversation's OWN duration — so a turn from "the previous session" decays
 * the same whether the dialogue is hours or weeks long. This is a structural
 * hypothesis test, NOT tuning to a gold metric: evidence survival is ground truth
 * (not a judge score), the new mode ships DEFAULT-OFF, and activation stays gated
 * on the full Tier-A suite (constitution / ADR-0011 discipline).
 *
 *   npm run eval:locomo:survival            # all 10 conversations, free
 *   LOCOMO_QUESTIONS=20 npm run eval:locomo:survival
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { createOnnxEncoder } from "../src/pruner/encoder";
import { prune, type HistoryEmbedding } from "../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams } from "../src/pruner/kadanedial";
import { loadLocomo, sampleQuestions, resolveEvidence, type LocomoConversation } from "../evals/harness/locomo";

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

// gainShift/theta stay at the documented defaults; only the decay model varies.
const G = DEFAULT_KADANEDIAL.gainShift;
const T = DEFAULT_KADANEDIAL.theta;
const CONFIGS: Config[] = [
  { label: "abs  λ=0.97 (DEFAULT, per-hour)", build: () => ({ lambda: 0.97, gainShift: G, theta: T }) },
  { label: "abs  λ=0.999 (per-hour)", build: () => ({ lambda: 0.999, gainShift: G, theta: T }) },
  { label: "abs  λ=1.0 (no decay)", build: () => ({ lambda: 1.0, gainShift: G, theta: T }) },
  { label: "span h=1.00·span (half-life = full span)", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: s }) },
  { label: "span h=0.50·span", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: 0.5 * s }) },
  { label: "span h=0.25·span", build: (s) => ({ lambda: 0.5, gainShift: G, theta: T, decayHorizonSeconds: 0.25 * s }) },
];

interface Row {
  survival: number[]; // per-question evidence-survival fraction
  reduction: number[]; // per-question context-reduction fraction
  earlySurvival: number[]; // survival for questions whose earliest evidence is in the FIRST third of turns
}

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const file = join(process.cwd(), "evals", "datasets", "locomo", "locomo10.json");
  if (!existsSync(file)) {
    out("GATED: evals/datasets/locomo/locomo10.json absent (CC-BY-NC; fetch from snap-research/locomo). Exiting 0.");
    return 0;
  }

  const perConv = envInt("LOCOMO_QUESTIONS", 12);
  const conversations = loadLocomo(file);
  out("LoCoMo evidence-survival sweep (FREE — local ONNX only, no judge/API)");
  out("=".repeat(70));
  out(`Conversations: ${conversations.length}/10   Questions/conv: ${perConv} (cats 1-4, timeline-spread)`);
  out("Evidence survival = gold-evidence turns kept ÷ gold-evidence turns total (deterministic).");
  out("'early' = questions whose earliest evidence is in the first third of the dialogue.");
  out("");

  const encoder = createOnnxEncoder({ cacheDir: join(process.cwd(), "models") });
  const rows = new Map<string, Row>();
  for (const c of CONFIGS) rows.set(c.label, { survival: [], reduction: [], earlySurvival: [] });

  for (const conv of conversations) {
    const qs = sampleQuestions(conv, { maxQuestions: perConv, categories: [1, 2, 3, 4] });
    if (qs.length === 0) continue;
    const turnVecs = await encoder.encode(conv.turns.map((t) => t.text));
    const queryVecs = await encoder.encode(qs.map((q) => q.query));
    const first = conv.turns[0]?.timestampSeconds ?? 0;
    const last = conv.turns[conv.turns.length - 1]?.timestampSeconds ?? 0;
    const span = Math.max(1, last - first);
    const nowSeconds = last + 3600;
    const history: HistoryEmbedding[] = conv.turns.map((t, i) => ({ embedding: turnVecs[i]!, timestampSeconds: t.timestampSeconds }));
    const earlyCut = conv.turns.length / 3;

    qs.forEach((q, qi) => {
      const ev = resolveEvidence(conv, q);
      if (ev.indices.length === 0) return;
      const isEarly = ev.indices[0]! < earlyCut;
      for (const cfg of CONFIGS) {
        const decision = prune(queryVecs[qi]!, history, { ...cfg.build(span), nowSeconds });
        const sel = new Set(decision.selectedIndices);
        const survived = ev.indices.filter((i) => sel.has(i)).length / ev.indices.length;
        const reduction = 1 - decision.selectedIndices.length / conv.turns.length;
        const row = rows.get(cfg.label)!;
        row.survival.push(survived);
        row.reduction.push(reduction);
        if (isEarly) row.earlySurvival.push(survived);
      }
    });
    out(`  ${conv.sampleId}: ${conv.turns.length} turns, span ${(span / 86400).toFixed(1)}d, ${qs.length} q encoded.`);
  }

  out("");
  out("config                                      evid-survival   early-evid   ctx-reduction");
  out("-".repeat(86));
  for (const cfg of CONFIGS) {
    const r = rows.get(cfg.label)!;
    out(
      `  ${cfg.label.padEnd(42)}  ${pct(mean(r.survival)).padStart(8)}      ${pct(mean(r.earlySurvival)).padStart(8)}     ${pct(mean(r.reduction)).padStart(8)}`,
    );
  }
  out("");
  out("Reading: absolute λ=0.97 collapses early-evidence survival (fixed 22.8h half-life vs week-long spans);");
  out("scale-invariant 'span h=…' decay should recover early-evidence survival at a comparable reduction.");
  out("This is a FREE leading indicator (PB-38). The ship decision still needs the API'd Faithfulness/Relevancy");
  out("gate (eval:locomo) re-run on the chosen config + MT-Bench+/SCM4LLMs (PB-41) — NOT a λ retune from this alone.");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("eval-locomo-survival.ts") || entryPath.endsWith("eval-locomo-survival.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
