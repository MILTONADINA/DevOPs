# Trusted fact coverage in shadow selection

**Scope:** `plan.md` §3c/§3e v0.4 quality gate. Measure whether the current
hot-window selector would lose exchanges that produced active typed facts.
This diagnostic does not activate pruning or replace the unchanged Tier-C and
published judged Tier-A gates.

## REQ-1 — Scoped active-fact exchange counts

WHEN a service caller supplies an authenticated organization, conversation
session, exact verified project, and bounded exchange IDs, THE DATABASE SHALL
return one count per exchange with at least one active FunctionChange,
TechDecision, PolicyUpdate, Todo, or VariableChange fact in that binding. It
SHALL count multiple facts from the same exchange without returning their
content. It SHALL exclude suppressed and legacy facts, foreign organizations,
sessions, projects, and non-conversation sessions. Anonymous and authenticated
roles SHALL not execute the lookup.

## REQ-2 — Observe dropped fact-bearing exchanges

WHEN opt-in shadow selection runs on a trusted conversation, THE OBSERVER SHALL
compare all in-window exchange IDs with the selected exchange IDs and report
active, selected, and dropped fact-bearing exchange counts. A dialogue exchange
with several active facts SHALL count once in each exchange count. The metric
SHALL contain only numeric counts and trusted IDs. A lookup failure SHALL not
alter the forwarded response. The observer SHALL keep its bounded window and
SHALL NOT treat the metric as proof that exchanges without extracted facts are
safe to remove. WHEN a clock is injected for observation or replay, THE HOT
WINDOW SHALL use that same clock for ingestion and eviction as the selector
uses for pruning.

## Acceptance criteria

- A focused observer test is red before implementation and then measures one
  dropped fact-bearing exchange while another survives selection.
- A rolled-back local SQL fixture proves all five fact tables, duplicate facts
  within one exchange, suppression, exact binding, and service-only grants.
- Focused adapter tests prove the exact RPC binding, empty input, and fail-closed
  errors; forwarding and default pruning remain unchanged.
