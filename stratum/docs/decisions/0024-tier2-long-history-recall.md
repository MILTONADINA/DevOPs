# ADR-0024: Tier-2 long-history recall assembly (option A), gated

Status: proposed (2026-09-25). The owner delegated this to the orchestrator's recommendation and may override it.

## Context

ADR-0023 moved Tier-C's long-history cases from the hot-window pruner to a Tier-2 recall follow-on. A design workflow (`wf_f4ca1043-e32`: 2 readers, 3 design angles, 3 judges) chose how a long conversation's forwarded context would be assembled.

## Decision

1. **Option A.** The 2 h Tier-1 hot window, plus any older exchange the proxy cannot prove safe to replace, is forwarded verbatim. A leading span of evicted, fully extracted, text-only exchanges is replaced by one block of typed facts recalled from exactly those exchanges for the current prompt (`specs/memory/tier2-long-history-recall.md`).
2. The spec keeps request-path assembly off. It adds a default-off shadow mode that logs counts only, and a free, local, deterministic Tier-C recall gate that uses pinned local-model extractions.
3. **Owner decision point, answered provisionally with option (ii).** Long-history request-path pruning and recall stay blocked until trusted currentness or authority signals exist for non-TechDecision facts (provenance spec decision 10). Mechanically produced, non-reviewed signals are not treated as trusted.

## Consequences

- Under option A, both the expected and the forbidden anchors of all 50 Tier-C cases sit in turns older than 2 h. The recall gate therefore covers all 50 cases, and the hot-window pruner cannot change any Tier-C outcome.
- With today's signals, 25 cases (stale update, negated decision, precise value, dormant repo fact) are expected to stay RED. They are reported, not fitted.
- Recall needs a stable client-configured `x-cq-conversation-id`, and real Claude Code does not send one today. Tool-heavy sessions replace almost nothing until tool-content extraction gets its own spec. Real savings from long-history recall are therefore not expected before those two items and decision 10 are resolved.
