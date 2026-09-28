# ADR-0023: Provenance-gated exchange selection, and what Tier-C gates

Status: proposed (2026-09-25). The owner delegated these decisions to the
orchestrator's recommendation and may override any of them.

## Context

v0.4's unchanged 50-case Tier-C gate passes 29/50 at the documented defaults
(λ=0.97 per hour, gainShift 0, θ=1). The 21 misses are 10 `tc-dormant-*` and
5 `tc-repo-*` cases, where an old relevant or authoritative fact loses to
recent noise or to a newer stale mention; 5 `tc-multi-*` cases, where two
facts are far apart; and `tc-negation-runtime`. The mechanism is that decay
multiplies raw similarity before z-normalization, so an 80-hour fact keeps
0.97^80 ≈ 0.087 of its similarity while one-hour noise keeps about 0.97.

KadaneDial's architectural input is the Tier-1 hot window: "Last 2 hours of
raw, verbatim dialogue turns ... This is the KadaneDial input"
(`docs/MEMORY_ARCHITECTURE.md`, Tier 1). The code agrees:
`createHotMemory` evicts turns older than `windowMs`, which defaults to
7,200,000 ms (`src/memory/hot/tier1.ts:55,64,71`), and the shadow observer
builds its context manager on that default and resets a conversation after 2 h
idle or 128 turns (`src/proxy/shadow-observer.ts:78-81`). Within 2 h, hourly
λ=0.97 lowers a score by at most 6%. Tier-C's ages run to 170 h, so its
dormant and long-range cases describe inputs the pruner never receives. Older
turns leave RAM and survive only as extracted Tier-2 facts.

Earlier attempts that changed the selector's parameters were rejected on
evidence (iterative maximum span; paper gain 0.6 took Tier-C from 29/50 to
18/50). The owner's handover forbids tuning to observed Tier-C or LoCoMo labels
and text heuristics for currentness. LoCoMo's 1,527 evidence-labelled
questions have all been observed in diagnostics, so only a 142-question
LongMemEval pool remains as a published holdout.

## Decision

1. Build the v0.4 pruner candidate as a default-off, shadow-only overlay on the
   unchanged KadaneDial decision, per `specs/pruner/provenance-gated-selection.md`.
   It changes the selection only through trusted provenance for earlier
   exchanges: reviewed TechDecision supersession and git `CONFLICT` can drop an
   exchange; a live, uncontested, query-matching typed fact can add one; the
   turns of a selected exchange are kept together. A git `CONFIRMED` status
   never breaks a contest.
2. Tier-C stays the gate it was, with a corrected scope: zero Tier-C failures
   is required before request-path pruning of any history longer than the 2 h
   hot window. For the hot-window candidate, Tier-C is a selection-identity
   no-regression check (the candidate must reproduce the base on all 50 cases).
3. Recovering facts older than the hot window is a Tier-2 recall follow-on with
   its own spec. That work must make Tier-C's long-history cases pass.
4. Activating ADR-0015 scale-invariant decay is evaluated as its own,
   separately gated candidate; it is not part of this one.

## Consequences

- The candidate cannot move the Tier-C score, by design, and does not claim to.
  Its proof is a separately authored provenance fixture, the Tier-C identity
  check, one pre-registered LongMemEval holdout tranche, and a latency bench.
- The judged Tier-A run, request-path pruning and billable savings remain
  blocked until both the candidate gates and the long-history (Tier-C) gate
  pass. No paid evaluation is part of this work.
- If the owner rejects decision 2, the candidate is still built (it is useful
  in shadow), and v0.4 waits for a selector change that passes Tier-C 50/50
  without tuning to observed labels.
