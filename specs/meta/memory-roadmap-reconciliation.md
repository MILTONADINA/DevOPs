# v0.5 memory roadmap reconciliation

**Date**: 2026-09-23
**Source**: `SHIP_BLOCKERS.md` §2.2 and the owner's instruction to complete the
remaining DevOPs roadmap.

## REQ-1 — Built state

WHEN the v0.5 checklist is refreshed, THE SYSTEM SHALL mark hot memory, typed
facts, the warm adapter, Supabase-backed graph/vector adapters, and the
50-turn survival test according to code and test evidence. It SHALL identify
Pinecone/Neo4j as optional future adapters under ADR-0013, not missing v0.5
ship dependencies.

## REQ-2 — Remaining gates

WHEN the roadmap names v0.5 completion, THE SYSTEM SHALL retain the actual
open requirements: DevOPs session-start retrieval/injection, a measured Tier-2
latency gate against the blueprint's <50ms p95 target, a scheduled promotion
job if nightly operation is required, and the planned graph view/tour work.
It SHALL NOT treat the existence of isolated modules as proof of live
request-path integration or release readiness.

## Acceptance criteria

- **AC-1**: `plan.md`, `blueprint.md`, and `SHIP_BLOCKERS.md` agree on the
  approved Supabase Tier-3 implementation and remaining v0.5 gates.
- **AC-2**: no unchecked v0.5 row describes code already built as absent, and
  no checked row claims a gate that is still unverified.
