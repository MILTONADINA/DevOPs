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

**Threshold:** treated as a hard signal at review time (the 1.4% result is an
unambiguous FAIL); a numeric floor is a v0.4.x calibration item tracked with the
λ-horizon work (ADR-0011 / ADR-0014). It is NOT used to auto-tune λ (over-fitting).

---

## Eval Datasets

### Tier A — Published Benchmarks (from DyCP paper)

Used to validate that our implementation of KadaneDial is correct and that the CQ-Extended variant does not regress vs. base DyCP.

| Dataset | Description | Turns | Fits the pruning evidence-survival gate? |
|---|---|---|---|
| **LoCoMo** | Long-term conversational memory; multi-session, timestamped, gold `evidence` dia-ids | 369–689 turns over 19–32 sessions / **weeks** | ✅ **YES** — long horizon + gold evidence anchors. Integrated + run. |
| ~~MT-Bench+ / MT-Bench-101~~ | Multi-turn response-QUALITY benchmark (13 tasks, subjective judging) | **≤7 turns, single session, no timestamps** | ❌ NO — too short to stress long-horizon memory; no gold evidence to measure survival against. (Apache-2.0; mtbench101/mt-bench-101.) |
| ~~SCM4LLMs~~ | A self-controlled-memory **FRAMEWORK codebase**, not a dataset | n/a | ❌ NO — ships **no eval dataset** (the authors state one doesn't exist; "validated solely through manual verification"). |

**Tier-A triage (2026-05-29):** the blueprint's original Tier-A list was inaccurate
— verified by inspecting each repo (Session 18). Only **LoCoMo** is a long-horizon,
evidence-anchored conversational-memory benchmark; the other two named sources do
not fit (above). The correct PEERS for breadth (to avoid over-fitting calibration to
one benchmark) are other long-horizon memory benchmarks with gold evidence —
**LongMemEval** (xiaowu0162/LongMemEval; 500 Qs over long histories, evidence-marked
sessions; the recommended second benchmark) and **MSC / Multi-Session Chat**. Tracked
as PB-41. Do not modify a fetched dataset; if results diverge from a paper's numbers,
investigate the implementation, not the data.

**Status (2026-05-29):** LoCoMo is integrated + RUN — `npm run eval:locomo`
(loader `evals/harness/locomo.ts`, sampled + cost-bounded; data CC-BY-NC,
gitignored, not redistributed). Result at the documented λ=0.97: **RED** —
1.4% evidence survival, 92% context reduction; the λ sweep shows λ=1.0 recovers
84% evidence at 47% reduction. Pruning stays OUT of the request path. Full
analysis: **ADR-0014**. The second-benchmark loader (LongMemEval/MSC, per the
Tier-A triage above — NOT MT-Bench+/SCM4LLMs, which don't fit) is pending (PB-41).

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

A hand-curated set of 50 (query, expected_answer) pairs derived from Tier B scenarios. These test specific facts that must survive pruning.

Format:
```json
{
  "id": "gc-001",
  "scenario": "function_deprecation",
  "turn_of_fact": 12,
  "query_turn": 50,
  "query": "Which function should I use to fetch a user from the database?",
  "expected_contains": ["fetchUser"],
  "expected_not_contains": ["getUser"],
  "critical": true
}
```

Critical queries (marked `"critical": true`) must pass with 100% accuracy. Any pruning configuration that fails a critical query is rejected, regardless of aggregate scores.

---

## Running the Eval Suite

```bash
# Full suite (runs all tiers, ~15 minutes)
npm run test:eval

# Fast suite (Tier B + Tier C only, ~4 minutes)
npm run test:eval -- --fast

# Specific scenario
npm run test:eval -- --scenario function_deprecation

# KadaneDial-specific (tests algorithm parameters)
npm run test:eval -- --suite kadanedial

# Compare two lambda values
npm run test:eval -- --compare-lambda 0.97 0.90
```

### Output Format

```
CQ Eval Suite v1.0
==================

Tier A — Published Benchmarks
  LoCoMo        Faithfulness: 0.924  AnswerRelevancy: 0.911  ✓
  MT-Bench+     Faithfulness: 0.901  AnswerRelevancy: 0.889  ✓
  SCM4LLMs      Faithfulness: 0.918  AnswerRelevancy: 0.903  ✓

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
│   ├── mtbench/          ← MT-Bench+ data
│   ├── scm4llms/         ← SCM4LLMs data
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
