# Query-matched fact rescue in shadow selection

**Scope:** `plan.md` §3c/§4, the existing bounded project lexical fact RPC,
and the shadow observer. The current KadaneDial decision can drop an exchange
whose current typed fact matches the new query. This is an observational
selection candidate; forwarding and pruning defaults remain unchanged.

## REQ-1 — Resolve bounded current query matches

WHEN shadow observation has a query and trusted hot exchange IDs, THE SERVICE
SHALL query only those bounded exchange IDs through
`find_query_hot_fact_exchanges` for the exact organization, project, and
conversation. It SHALL accept only current unsuppressed typed fact rows with
those bindings, count each matching fact row once, and reject malformed rows
or invalid project scope. The database's reviewed-supersession exclusion SHALL
apply before this candidate is formed.

## REQ-2 — Measure a proposed rescue without forwarding it

WHEN the observer's current selected turns omit any turn from an exchange with
a matching current fact, THE OBSERVER SHALL propose adding the missing
in-window turns for that exchange and report the number of rescued exchanges,
matching fact rows, and additional turns. It SHALL count an exchange once even when both user and
assistant turns are present. IF a hot memory write failed, THEN THE OBSERVER
SHALL omit the candidate until the failed exchange leaves the window. It
SHALL emit counts only, never fact text or IDs, and SHALL NOT modify the
actual request context or base pruner decision.

## Acceptance criteria

- Failing-first tests show a query-matched dropped exchange is proposed once,
  a partially selected exchange is completed, while a fully selected exchange is
  not rescued again and a failed write omits the
  candidate.
- Focused adapter tests reject malformed or foreign exchange rows and enforce
  the 128-exchange bound.
- A disposable local database fixture verifies the real RPC and adapter on
  mixed-fact exchanges under the exact project/session binding.
- Typecheck, changed-source lint, and formatting pass. The unchanged Tier-C
  and published holdouts remain release gates; this shadow-only candidate
  does not claim to pass them because those datasets lack typed exchange
  provenance and reviewed decision links.
