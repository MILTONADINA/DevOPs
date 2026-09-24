# Exchange-bound function supersession in shadow mode

**Scope:** Measure whether selected commercial conversation turns can be tied to
project-bound function supersession through their server-minted exchange IDs.
This is a shadow diagnostic. Forwarded messages and the default pruning gate
remain unchanged.

## REQ-1 — Resolve an exchange conservatively

WHEN a service caller supplies an authenticated organization, conversation
session, verified project, and selected exchange IDs, THE SYSTEM SHALL return
one function entity name per exchange only when active typed `FunctionChange`
facts in that exact binding agree on one name. A fact with a nonempty new name
SHALL identify the new function; otherwise it SHALL identify the old function.
The lookup SHALL exclude suppressed facts, legacy facts without exchange IDs,
foreign organizations, sessions, projects, and non-conversation sessions. An
ambiguous exchange SHALL return no entity. Anonymous and authenticated database
roles SHALL not execute the lookup.

## REQ-2 — Measure selected-turn supersession

**Metric correction:** `specs/pruner/fresh-exchange-supersession.md` supersedes
the turn-count metric below. An exchange-level fact cannot prove that both
dialogue turns contain only that fact.

WHEN shadow selection returns turns with trusted exchange IDs, THE OBSERVER
SHALL resolve their function entities using REQ-1, query the existing
project-bound and provenance-complete graph supersession relation, and measure
the selected turns whose entity is superseded by an entity also selected.
An exchange without a unique resolved entity SHALL remain selected. The
observer SHALL emit only numeric counts and trusted IDs, and a lookup failure
SHALL not alter the forwarded response. The observer SHALL retain its current
bounded conversation window and default-off deployment switch.

## Acceptance criteria

- Focused tests fail before implementation, then show exact RPC binding,
  empty-list handling, ambiguous/unbound turns retained, and numeric-only
  shadow supersession counts.
- A rolled-back local PostgreSQL fixture shows same-named functions in two
  projects, two sessions, suppressed and ambiguous facts, and service-only
  access. Only the exact conversation/project/exchange binding resolves.
- The unchanged Tier-C corpus and judged Tier-A requirements remain release
  gates; this diagnostic does not activate request pruning.
