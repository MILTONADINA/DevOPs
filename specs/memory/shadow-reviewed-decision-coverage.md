# Reviewed-decision eligibility in shadow coverage

**Scope:** `plan.md` §3c/§4, the existing service-only
`find_active_fact_exchanges` lookup, and the reviewed supersession rule used
by SessionStart. Shadow coverage should measure facts eligible for current
recall, so an obsolete decision must not inflate the dropped-fact signal.

## REQ-1 — Exclude a reviewed obsolete decision

WHEN the service counts fact rows for a trusted organization, conversation,
project, and source exchange, THE DATABASE SHALL exclude an unsuppressed
TechDecision A if an active later TechDecision B in that exact organization
and project has a reviewed `supersedes_id` link to A, even when B belongs to
another conversation. It SHALL count B when B belongs to the requested
conversation and exchange. An unreviewed, foreign,
wrong-project, older, or suppressed successor SHALL NOT hide A. The service
lookup SHALL retain its existing role restrictions and return counts only.

## REQ-2 — Preserve other facts in the source exchange

IF an exchange also has another eligible typed fact, THEN excluding A SHALL
decrement that exchange's count by one while retaining the other fact. IF B
becomes suppressed, THEN A SHALL be counted again, matching current recall.
The shadow observer SHALL use those counts without changing request context
or enabling pruning.

## Acceptance criteria

- A rolled-back local database fixture fails before the migration because A
  is still counted after a reviewed link, then passes after the migration.
  It verifies counts before review, after review, and after suppressing B,
  including an unrelated fact in A's exchange.
- The existing exchange lookup fixture and the real shadow coverage adapter
  fixture still pass; all grants remain service-only.
