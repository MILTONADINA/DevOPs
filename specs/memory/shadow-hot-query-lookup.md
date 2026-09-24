# Exact hot-exchange lexical lookup for shadow rescue

**Scope:** `plan.md` §3c/§4 and
`specs/memory/shadow-query-fact-rescue.md`. The current shadow adapter asks
the project-wide SessionStart search for its top 20 rows and filters those
rows to one conversation. Twenty unrelated same-project hits can crowd out a
matching hot exchange before that filter runs.

## REQ-1 — Filter to trusted hot exchanges before matching

WHEN the service asks for query-matched current facts in shadow selection,
THE DATABASE SHALL restrict candidates to the exact organization,
conversation-kind session, project, and supplied source exchange IDs before
lexical matching and counting. It SHALL use the same bounded query token
parsing and typed-text fields as `search_project_warm_facts`, but SHALL return
only an exchange ID and its matching fact-row count. It SHALL include all six
typed fact tables, exclude suppressed facts and reviewed obsolete decisions,
and avoid any project-wide top-k truncation before exact binding. The RPC
SHALL be callable only by the service role.

## REQ-2 — Validate the bounded result in the shadow adapter

WHEN the adapter calls the exact lookup, IT SHALL limit the query to 1,200
characters and accept at most 128 trusted exchange IDs. It SHALL reject a
malformed, duplicate, nonpositive, or unrequested result instead of emitting
it. An empty query or exchange list SHALL issue no RPC. The observer SHALL
continue to emit only proposed rescue counts and SHALL NOT change the
forwarded request or base pruner decision.

## Acceptance criteria

- A failing-first rolled-back local SQL fixture inserts more than 20 higher
  ranked same-project facts in other conversations, proves the old project
  search misses the target hot exchange, and proves the new lookup finds it.
- The fixture verifies unrelated, suppressed, foreign, and reviewed-obsolete
  facts do not inflate the returned count and checks service-only grants.
- Focused adapter tests fail before implementation and pass after binding the
  exact RPC and rejecting malformed rows.
- The existing real shadow-observer integration and focused tests pass;
  typecheck and changed-source lint/format pass. Request pruning remains
  disabled pending the unchanged Tier-C and judged published gates.
