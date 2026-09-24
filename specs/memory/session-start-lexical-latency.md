# Indexed SessionStart lexical candidates

**Scope:** `plan.md` §4 Tier-2 latency and
`specs/memory/session-start-lexical-candidates.md`. A local 10,001-decision
probe of the current RPC took about 40 ms for a selective two-term task because
it builds a search vector for every scoped row. A matching GIN expression
index gave a bitmap scan in 0.038 ms for the same selective predicate. This is
local evidence; the deployed Tier-2 p95 gate remains open.

## REQ-1 — Index all typed lexical sources

WHEN SessionStart searches a project for lexical fact candidates, THE DATABASE
SHALL use indexable text-search expressions on all five typed fact tables and
retain exact organization/project filtering, suppression, reviewed decision
supersession, the 20-row cap, and service-role-only access. Indexes SHALL add
no generated columns to backup/restore payloads.

## Acceptance criteria

- A disposable 10,001-decision local PostgreSQL fixture fails before the
  migration because its selective query cannot use the expected lexical GIN
  index, and passes after it with the index in the query plan.
- The same fixture checks the presence of all five partial GIN indexes.
- The existing rolled-back lexical scope fixture, SessionStart focused tests,
  typecheck, and real local encoder check pass after migration.
- Record selective and broad full-RPC timing separately. This local check does
  not satisfy the representative deployed p95 gate.
