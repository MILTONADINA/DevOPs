# Fact-level coverage in shadow selection

**Scope:** `plan.md` §3c/§4 and the existing service-only
`find_active_fact_exchanges` lookup. A commercial exchange can contain more
than one active typed fact; counting its selected turn once hides how many
facts the shadow pruner would lose.

## REQ-1 — Count active facts behind selected exchanges

WHEN the shadow observer receives active fact counts for trusted exchanges in
the exact organization, conversation, and project, THE OBSERVER SHALL report
the total active, selected, and dropped **fact rows** as well as its existing
exchange counts. It SHALL sum each exchange's active count once even though
the hot window holds both user and assistant turns for that exchange. A fact is
selected when either turn from its source exchange is selected. The three fact
counts SHALL satisfy active = selected + dropped.

## REQ-2 — Preserve incomplete-provenance handling

IF any hot exchange has a failed memory write, THEN THE OBSERVER SHALL omit
all fact and exchange coverage counts until that exchange leaves the window.
The metric SHALL report counts only; it SHALL NOT emit fact text, change the
actual request context, or enable pruning.

## Acceptance criteria

- A failing-first focused test distinguishes a two-fact exchange from a
  one-fact exchange and proves the selected/dropped row totals.
- A disposable local database fixture with unequal per-exchange row counts
  proves the service lookup and observer totals agree, while an existing
  failed-write test proves all coverage remains omitted.
- Typecheck and changed-source lint pass; request pruning stays disabled.
