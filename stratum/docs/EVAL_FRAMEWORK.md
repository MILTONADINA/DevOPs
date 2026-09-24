# EVAL_FRAMEWORK.md — Pruning Accuracy Measurement

## Why Evals Gate Every Pruning Change

Startum's core promise is: **same AI quality, fewer tokens.** If our pruning degrades reasoning quality, we are not solving the problem — we are creating a new one.

The eval suite is the definition of "correct pruning." No pruning change ships without passing it. This is not optional. Speed of shipping is not a valid reason to skip evals.

---

## The Two Metrics That Matter

### 1. Faithfulness

> Does the AI's answer, given the pruned context, remain faithful to the facts in the full context?

A pruning run that removes a critical decision from history causes the AI to hallucinate or contradict that decision. Faithfulness catches this.

**Tool:** DeepEval `FaithfulnessMetric`
**Threshold:** Score > 0.90 (degradation vs. full-context baseline < 5%)

### 2. Answer Relevancy

> Is the AI's answer still as on-topic and useful as it would have been with full context?

A pruning run that removes too much leaves the AI with insufficient information to give a complete answer. Answer Relevancy catches under-pruning consequences.

**Tool:** DeepEval `AnswerRelevancyMetric`
**Threshold:** Score > 0.88 (degradation vs. full-context baseline < 5%)

**Gating semantics (ADR-0016, 2026-05-29):** the gate is **degradation-dominant** —
a metric fails on `(baseline − pruned) ≥ 5%`, OR when pruning drops a *floor-clearing*
baseline below the floor. When BOTH pruned and baseline are sub-floor, the floor miss
is an answerer/judge ceiling (a hard question), recorded as a diagnostic, NOT a pruning
fail. This matches the constitution's stated criterion (degradation) and stops the gate
mis-attributing task-difficulty to pruning.

### 3. Evidence Survival (co-gate for long-horizon datasets) — ADDED 2026-05-29

> Of the turns the dataset pins as containing the answer (gold `evidence`), what
> fraction survived pruning?

The first real Tier-A run (LoCoMo, ADR-0014) showed Faithfulness + Answer
Relevancy are **insufficient on their own** for long-horizon memory: a pruner
that retained only **1.4%** of evidence scored *higher* than the full-context
baseline on both metrics. Reason: feeding the answerer the entire 400–700-turn
conversation **dilutes** its answer, while a recent-only pruned context yields a
crisp answer that is faithful-to-what-was-kept but **not grounded in the actual
evidence** (plausible bluffing from recency). LLM-judged fluency rewarded the
wrong thing.

**Evidence survival** is deterministic (no judge), gold-anchored, and ungameable:
resolve each QA's `evidence` dialogue-ids to turn indices, intersect with the
pruner's selection. For any dataset that ships gold evidence (LoCoMo does),
**this co-gates** the LLM metrics — a pruning change must not tank evidence
survival even if Faithfulness/Relevancy look fine.

**Threshold:** a formal suite co-gate (ADR-0016 / PB-39): a scenario carrying an
`evidenceSurvival` value fails if it is below `evidenceSurvivalMin` (default **0.80**
— lose ≤20% of answer evidence). The floor is a documented, tunable v0.4.x
calibration item — NOT used to auto-tune λ (over-fitting). It runs alongside the
degradation-dominant metric gate, so the suite neither false-PASSes a bluffing pruner
(this co-gate) nor false-FAILs on hard-question baseline ceilings (the metric gate).

---

## Eval Datasets

### Tier A — Published long-horizon benchmarks

Used to measure long-horizon evidence retention and judged answer quality before activating CQ-Extended pruning.

| Dataset | Description | Turns | Fits the pruning evidence-survival gate? |
|---|---|---|---|
| **LoCoMo** | Long-term conversational memory; multi-session, timestamped, gold `evidence` dia-ids | 369–689 turns over 19–32 sessions / **weeks** | ✅ **YES** — long horizon + gold evidence anchors. Loader and sampled runner integrated. |
| **LongMemEval** | Long-term chat memory; timestamped sessions and `has_answer` evidence flags | 500 questions across long histories | ✅ **YES** — second long-horizon evidence benchmark. Loader and separate runner integrated. |
| ~~MT-Bench+ / MT-Bench-101~~ | Multi-turn response-QUALITY benchmark (13 tasks, subjective judging) | **≤7 turns, single session, no timestamps** | ❌ NO — too short to stress long-horizon memory; no gold evidence to measure survival against. (Apache-2.0; mtbench101/mt-bench-101.) |
| ~~SCM4LLMs~~ | A self-controlled-memory **framework**, not an integrated benchmark in this project | n/a | ❌ NO — its code repository does not supply the long-horizon, turn-level evidence fixture this gate consumes. |

**Tier-A triage (2026-05-29):** the blueprint's original Tier-A list was inaccurate
— verified by inspecting each repo (Session 18). Only **LoCoMo** is a long-horizon,
evidence-anchored conversational-memory benchmark; the other two named sources do
not fit (above). The correct PEERS for breadth (to avoid over-fitting calibration to
one benchmark) are other long-horizon memory benchmarks with gold evidence —
**LongMemEval** (xiaowu0162/LongMemEval; 500 Qs over long histories, evidence-marked
sessions; the recommended second benchmark) and **MSC / Multi-Session Chat**. Tracked
as PB-41. Do not modify a fetched dataset; if results diverge from a paper's numbers,
investigate the implementation, not the data.

**Status (2026-09-24):** LoCoMo is integrated + sampled judged RUN — `npm run eval:locomo`
(loader `evals/harness/locomo.ts`, sampled + cost-bounded; data CC-BY-NC,
gitignored, not redistributed). Result at the documented λ=0.97: **RED** —
1.4% evidence survival, 92% context reduction; the λ sweep shows λ=1.0 recovers
84% evidence at 47% reduction. Pruning stays OUT of the request path. Full
analysis: **ADR-0014**. LongMemEval's loader and separate judged runner
(`npm run eval:longmemeval`) are also implemented. The default full-suite
command now invokes both published gates over the complete local corpora after
Tier-C and judged Tier-B; a full passing judged run remains open (PB-41).

**Acquisition and license:** Obtain `locomo10.json` from the
[official LoCoMo repository](https://github.com/snap-research/locomo/tree/main/data)
for local noncommercial evaluation under its
[CC BY-NC 4.0 license](https://github.com/snap-research/locomo/blob/main/LICENSE.txt).
Obtain `longmemeval_s.json` from the
[official LongMemEval dataset instructions](https://github.com/xiaowu0162/LongMemEval/blob/main/README.md#data)
for local evaluation under the repository's
[MIT license](https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE).
Keep downloaded corpora out of Git. Dataset availability does not satisfy a
judged quality gate.

### Tier B — CQ Developer Workload Dataset

Developer-specific sessions that test the scenarios CQ is actually built for. These are synthetic but realistic, generated by running real coding sessions and anonymizing them.

| Scenario | Description | Key test |
|---|---|---|
| Function deprecation | 50-turn session where `getUser()` is deprecated in turn 12 | Can the AI recall the replacement 38 turns later? |
| Tech stack migration | 80-turn session with a Postgres → Supabase migration decision at turn 20 | Is the decision present in pruned context 60 turns later? |
| Multi-project bleed | Two interleaved project sessions (A and B) in 100 turns | Does CQ prevent Project A logic from leaking into Project B answers? |
| Stale API key | Config change at turn 5, query at turn 95 | Does λ decay correctly de-prioritize the stale turn? |
| Long dormant session | 10-turn session, 6-hour gap, 10 more turns | Is time-based decay working correctly across the gap? |
| Tool output bloat | Session with 40% tool call results | Are repetitive tool outputs pruned without losing unique results? |

### Tier C — Golden Query Set

A project-local JSONL corpus of 50 synthetic developer-workload cases covers
stale updates, project scope, dormant facts, multi-fact answers, negation, and
exact values. Each critical query checks the context selected by the real
cached ONNX encoder and KadaneDial pruner. The cases have required and
forbidden anchors, so keeping everything and dropping everything both fail.
This corpus does not replace published Tier-A judged evaluation.

Format:
```jsonl
{"id":"tc-stale-api-route","scenario":"stale_update","query":"Which API version handles new requests?","golden":{"contains":["api-v2"],"notContains":["api-v1"],"critical":true},"turns":[{"text":"New requests use api-v1.","ageHours":96},{"text":"The icon layout was reviewed for the dashboard.","ageHours":20},{"text":"New requests use api-v2.","ageHours":4},{"text":"The changelog typography was adjusted.","ageHours":1}]}
```

Critical queries must pass with 100% accuracy. The documented default
λ=0.97, gainShift=0, θ=1 scored **29/50** after trusted project filtering;
this gate is RED. The remaining 21 cases include dormant facts, multi-fact
answers, and stale alternatives. Run `npm run eval:tierc` for the offline gate and inspect every
missing/leaked anchor before changing pruning behavior.

---

## Running the Eval Suite

```bash
# Full suite entry point: default command invokes all 1,540 answerable LoCoMo and 500 LongMemEval questions after Tier-C and judged Tier-B; currently exits nonzero on red Tier-C
npm run test:eval

# Fast suite: Tier C then judged Tier B; currently returns nonzero on red Tier C
npm run test:eval -- --fast

# Offline critical-query gate (no judge or API key)
npm run eval:tierc
```

### Output Format

```
CQ Eval Suite v1.0
==================

Tier A — Published Benchmarks
  LoCoMo        Faithfulness: 0.924  AnswerRelevancy: 0.911  ✓
  LongMemEval   Faithfulness: 0.901  AnswerRelevancy: 0.889  ✓

Tier B — Developer Workload
  func_deprecation   Faithfulness: 0.956  AnswerRelevancy: 0.941  ✓
  tech_migration     Faithfulness: 0.934  AnswerRelevancy: 0.928  ✓
  multi_project      Faithfulness: 0.889  AnswerRelevancy: 0.872  ✗  ← BELOW THRESHOLD
  ...

Tier C — Golden Queries
  50/50 passed  (0 critical failures)  ✓

RESULT: FAIL — multi_project scenario below Faithfulness threshold (0.889 < 0.90)
Action required: increase context window for cross-project sessions or tune θ parameter.
```

---

## Eval Harness Architecture

```
evals/
├── datasets/
│   ├── locomo/           ← LoCoMo benchmark data
│   ├── longmemeval/      ← LongMemEval benchmark data
│   ├── developer/        ← Tier B synthetic sessions
│   └── golden/           ← Tier C golden query set
├── harness/
│   ├── runner.ts         ← Main eval runner
│   ├── metrics.ts        ← DeepEval integration
│   ├── baseline.ts       ← Full-context (no pruning) baseline runner
│   └── compare.ts        ← Delta computation vs baseline
├── fixtures/
│   └── sessions/         ← Pre-built session fixtures for Tier B
└── results/
    └── .gitignore        ← Results not committed (too large)
```

### How the Harness Works

1. Load the session fixture (raw turns with timestamps)
2. Run KadaneDial with the current parameters → get pruned context
3. Send pruned context to Claude Haiku (cheapest model, consistent scoring)
4. Send full context to Claude Haiku (baseline)
5. Evaluate both responses with DeepEval metrics
6. Compute delta: `score_pruned - score_baseline`
7. Fail if delta < -0.05 on any metric

Using Haiku for evals keeps costs low. The eval is testing pruning quality, not model quality.

---

## When to Run Evals

| Change type | Required eval run |
|---|---|
| Any change to `ALGORITHM.md` parameters (λ, g, θ) | Full suite |
| Any change to `src/pruner/` | Full suite |
| Any change to memory retrieval logic | Tier B + Tier C |
| Any change to fact extraction prompts | Tier B only |
| Dependency upgrades (ONNX model, tokenizer) | Full suite |
| Config changes (per-org lambda tuning) | Tier B + affected scenarios |
| Bug fixes with no pruning logic changes | Tier C only (fast) |

---

## Acceptable Thresholds Summary

| Metric | Minimum score | Maximum degradation vs baseline |
|---|---|---|
| Faithfulness | 0.90 | -5% |
| Answer Relevancy | 0.88 | -5% |
| Critical golden queries | 100% pass rate | 0 failures allowed |
| ONNX inference latency (p99) | — | 15ms |
| KadaneDial latency (p99) | — | 5ms |

Any run that fails any threshold is a blocking failure. Do not merge. Do not ship.
