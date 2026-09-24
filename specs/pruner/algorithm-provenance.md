# Pruner algorithm provenance and transfer evidence

**Scope:** `plan.md` §3b and `stratum/docs/ALGORITHM.md`. This documentation correction does not change the implementation or the v0.4 release gate.

## REQ-1 — Distinguish paper from product

WHEN the project describes base DyCP, THE ALGORITHM DOCUMENT SHALL state that the paper embeds completed dialogue pairs, uses `τ=0.6` and `θ=1.0`, and iteratively selects global maximum-sum spans. WHEN it describes Stratum's current implementation, THE DOCUMENT SHALL name its `gainShift=0`, local-run span selection, and temporal decay as adaptations rather than attributing them to the paper.

## REQ-2 — Consistent scoring formula

WHEN the roadmap describes the implemented CQ-Extended score, IT SHALL specify decay of raw cosine similarity before z-normalization and gain subtraction afterward, consistent with `src/pruner/kadanedial.ts`.

## REQ-3 — Honest diagnostic

WHEN a method-transfer comparison is recorded, THE NOTES SHALL distinguish the unchanged Tier-C count from published LoCoMo evidence survival, name the encoder and sample, and state that neither metric is a judged answer-quality release pass. THE NOTES SHALL NOT change pruning defaults or relax either gate.
