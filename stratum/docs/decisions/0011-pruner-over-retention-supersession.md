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

Two candidate fixes were implemented and **empirically ruled out** (not assumed):

1. **θ / λ tuning** — `npm run sweep-params` (deterministic golden over a 6×3
   grid): **no (θ, λ) cell beats 9/11.** Raising θ *drops needed facts*
   (θ=1.5 → 4/11); lowering λ drops legitimately-old facts. θ=1.0 is already
   optimal. The 2 failures fail at **every** cell ⇒ the limit is structural, not
   parametric.
2. **Per-turn gain-floor trim** (`trimCarriedTurns`, opt-in, implemented +
   unit-tested) — drops selected turns whose own normalized gain ≤ g. Measured
   via the sweep: **still 9/11.** The kept turns are NOT negative-gain "carried"
   turns — they are *positive-gain, genuinely on-topic* (the Lambda plan is
   topical for "where deploying"; decay flattens the old RS256 fact so an
   off-topic recent turn is z-comparable). A relevance floor cannot distinguish
   them.

So the over-retention is **supersession + decay/relevance interaction**: a newer
turn invalidates an older *topical* one, which cosine similarity + temporal decay
cannot detect on their own.

## Decision

Defer the fix to a dedicated, Tier-A-validated change (do NOT over-fit the 11
synthetic scenarios). The proposed approach, to be validated against the published
Tier-A datasets (LoCoMo / MT-Bench+ / SCM4LLMs) before activation:

1. **Supersession edges from Tier-3 (primary).** The Neo4j knowledge graph
   already models `SUPERSEDES` edges (Decision→Decision) and `DEPRECATED_BY`
   (Function). When a selected turn's entity has an outgoing supersession edge to
   another entity present in (or more recent than) the context, suppress the
   superseded turn. This is deterministic + explainable and reuses the audit
   graph rather than guessing from embeddings. Gated on the Neo4j adapter
   (v0.5.x, account).
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

- **θ / λ tuning** — ruled out by the parameter sweep (no cell > 9/11; tuning
  regresses other scenarios). See Context.
- **Per-turn gain-floor trim** — implemented + measured out (still 9/11; the kept
  turns are positive-gain). See Context.
- **Relax the goldens / mark the 2 scenarios non-critical** — rejected: that is
  the eval-vacuity an adversarial review already caught once; the gate SHOULD be
  red while a real limitation exists.
- **LLM-judged supersession at prune time** — rejected for the hot path: too slow
  / costly to run per turn (the extractor already does structured extraction
  off-path; supersession belongs in Tier-3, not the pruner's inner loop).
