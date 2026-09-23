# ADR-0011: v0.4.x Pruner Over-Retention — Finding & Supersession-Fix Design

**Date:** 2026-05-29
**Status:** Proposed (design only; implementation + activation gated on Tier-A validation)

## Context

The expanded Tier-B eval (`npm run eval:tierb`, 11 scenarios) surfaced a real,
reproducible pruner limitation. All 11 scenarios preserve **answer faithfulness
+ relevancy at 1.0**, but **2/11 fail the strict golden** — `tb-dormant` and
`tb-negation` — both because the pruner **keeps a turn it should drop**:

- `tb-negation`: keeps the superseded "deploy on AWS Lambda" plan alongside the
  correct "Cloudflare Workers" decision.
- `tb-dormant`: keeps an off-topic "logo alignment" turn alongside the (heavily
  time-decayed) RS256 fact.

Root cause: **KadaneDial selects *contiguous* spans.** A turn adjacent to the
relevance peak is retained inside the span. It is a **precision** cost, not a
correctness one (the answer stays faithful because the needed fact is also kept)
— but the eval gate is intentionally RED on it, correctly blocking ship until
addressed.

Candidate fixes were measured (`npm run sweep-params`). **This conclusion was
overstated TWICE before being read straight off the matrix** (first "not tunable
/ structural", then "tb-negation fails at every cell" — both false). The accurate
finding: **the two hard scenarios have OPPOSING λ requirements**, so no single
(θ,λ) reaches 11/11; the max anywhere is **10/11**.

1. **θ / λ tuning** — both failures are individually λ-recoverable, but in
   opposite directions:
   - **tb-dormant** passes ONLY at **λ≥0.99** (gentle decay: the 80h answer must
     not sink below a 10h noise turn); fails at λ≤0.98.
   - **tb-negation** passes ONLY at **λ≤0.95** (heavy decay drops the stale 30h
     "AWS Lambda" turn so the contiguous span no longer reaches it); fails at
     λ≥0.97 (the stale turn is positive-gain + on-topic + adjacent there).
   Satisfying one fails the other (and low-λ recovery of tb-negation newly fails
   tb-migration). **No scenario fails at every cell**, so neither is "structural"
   in the strict sense — but λ alone cannot satisfy both. Raising θ instead drops
   needed facts. The λ default is NOT retuned on an 11-scenario dev set (Tier-A's
   job); the data shows a λ TENSION, not a new default.
2. **Per-turn gain-floor trim** (`trimCarriedTurns`, opt-in, default-OFF) — does
   NOT help at the default λ: the kept turn is *positive-gain, on-topic* (the
   stale Lambda plan is topical for "where deploying"), not a negative-gain
   "carried" turn a relevance floor could drop.

The motivation for **supersession** is therefore the λ TENSION, not strict
unrecoverability: a mechanism orthogonal to decay (drop a turn a newer one
invalidates, regardless of λ) could reach 11/11 WITHOUT trading tb-dormant
against tb-negation. A newer turn invalidates an older *topical* one, which
cosine similarity + temporal decay
cannot detect on their own.

## Decision

Defer the fix to a dedicated, Tier-A-validated change (do NOT over-fit the 11
synthetic scenarios). The proposed approach, to be validated against the published
Tier-A datasets (LoCoMo / MT-Bench+ / SCM4LLMs) before activation:

1. **Supersession edges from Tier-3 (primary).** The knowledge graph models
   `SUPERSEDES` edges (Decision→Decision) and `DEPRECATED_BY` (Function). When a
   selected turn's entity is superseded by another entity present in (or more recent
   than) the context, suppress the superseded turn. This is deterministic +
   explainable and reuses the audit graph rather than guessing from embeddings.
   **STATUS — now IMPLEMENTABLE (Session 17):** Tier-3 was built on Supabase
   (ADR-0013) instead of Neo4j (no account) — `knowledge_entities` + `knowledge_edges`
   + the `find_superseded(org, names[])` SQL fn (live-verified via MCP), exposed by
   `KnowledgeGraph.findSuperseded` (`src/memory/cold/graph.ts`). The suppression step
   itself is built + unit-tested as the PURE, DEFAULT-OFF `suppressSuperseded`
   (`src/pruner/supersession.ts`): given the `find_superseded` pairs, it drops a
   selected turn whose entity is superseded by an entity also present — orthogonal to
   λ, so it resolves `tb-negation` WITHOUT trading off `tb-dormant` (verified on the
   synthetic tb-negation shape in `test/pruner/supersession.test.ts`).
   **ACTIVATION REMAINS Tier-A-GATED**: it is wired NOWHERE in the request path; the
   <5% Faithfulness validation on the published Tier-A datasets is still required
   before it becomes a pruner default (constitution + ADR-0009). What is gated is no
   longer "a Neo4j account" but "the Tier-A eval run".
2. **Recency-conditioned relevance (fallback, no graph).** For two turns whose
   similarity to the query is within ε of each other AND that are
   topically-near each other (high pairwise similarity), prefer the more recent
   and suppress the older. A heuristic for the no-graph path; risk: it can drop a
   valid older turn, so it must clear the <5% Faithfulness bar on Tier-A before
   it ships.

The `trimCarriedTurns` refinement stays as a sound default-OFF option for the
negative-gain case it *does* address.

## Consequences

- The eval gate stays RED on `tb-dormant` / `tb-negation` until this lands —
  correctly blocking pruning from the request path (constitution + ADR-0009).
- Option 1 couples the pruner to Tier-3; until the Neo4j adapter exists, the
  pruner runs without supersession suppression (current behavior).
- Whichever option is chosen, it is a pruning-logic change → requires a full
  Tier-A eval run showing <5% Faithfulness degradation before activation.
- This ADR + the `kadanedial.ts` header + `sweep-params` make the analysis
  reproducible, so the future implementation starts from data, not a blank slate.

## Alternatives Considered

- **θ / λ tuning** — both hard scenarios are individually λ-recoverable but with
  OPPOSING needs (tb-dormant λ≥0.99, tb-negation λ≤0.95), so no single λ exceeds
  10/11; satisfying one fails the other. λ is not retuned here (Tier-A's job). See Context.
- **Per-turn gain-floor trim** — implemented + measured out for tb-negation
  (positive-gain on-topic turn, not a negative-gain carried turn). See Context.
- **Relax the goldens / mark the 2 scenarios non-critical** — rejected: that is
  the eval-vacuity an adversarial review already caught once; the gate SHOULD be
  red while a real limitation exists.
- **LLM-judged supersession at prune time** — rejected for the hot path: too slow
  / costly to run per turn (the extractor already does structured extraction
  off-path; supersession belongs in Tier-3, not the pruner's inner loop).
