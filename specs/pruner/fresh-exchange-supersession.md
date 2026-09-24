# Fresh exchange supersession candidates in shadow mode

**Scope:** Correct the exchange-to-turn inference in
`exchange-function-shadow.md` and measure new Function renames before the
30-day Tier-3 promotion cutoff. This remains an opt-in shadow diagnostic.

## REQ-1 — Fresh relation from the authenticated conversation

WHEN a service caller supplies an organization, conversation session, exact
project, and selected exchange IDs, THE SYSTEM SHALL return active
`FunctionChange` rename relations from those exchanges only. A relation SHALL
have nonempty, distinct old and new names; suppressed and legacy facts SHALL
not contribute. The session SHALL be a conversation in that organization and
project. Anonymous and authenticated roles SHALL not execute the lookup.

## REQ-2 — Count candidate exchanges without implying safe turn deletion

WHEN shadow selection contains exchange-bound turns, THE OBSERVER SHALL count
distinct selected exchanges whose unambiguous function entity is superseded by
an entity from another selected exchange. It SHALL obtain fresh relations
under REQ-1 and may also count the verified project graph relation. It SHALL
request fresh relations only for selected exchanges that resolved to one
eligible function entity; unresolved or mixed-fact exchanges SHALL NOT supply
a relation to another candidate.
It SHALL
report only numeric counts and trusted IDs. It SHALL NOT treat the candidate
count as authorization to drop either dialogue turn, alter forwarding, or
enable pruning. Ambiguous exchanges and failures SHALL fail closed for the
diagnostic while preserving the forwarded response.

## Acceptance criteria

- Focused tests first fail, then prove the exact service RPC binding, empty
  input, fail-closed errors, and a candidate count of one for a two-turn stale
  exchange paired with a newer rename exchange.
- A rolled-back local SQL fixture proves fresh rename, same-session/project
  isolation, suppressed/legacy exclusion, and service-only grants.
- The Tier-C dataset and judged Tier-A release gates remain unchanged; the
  request path still forwards the full message.
