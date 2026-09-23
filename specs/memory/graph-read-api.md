# Organization-scoped graph read API

**Scope:** `plan.md` §4f's graph dashboard foundation over the existing local
Tier-3 entity and edge tables.

## REQ-1 — Bounded graph snapshot

WHEN an operator requests `GET /v1/memory/graph`, THE SYSTEM SHALL return a
bounded snapshot of graph entities and edges for the request's organization.
It SHALL include only edges whose endpoints are in the returned entity set.
The response SHALL expose entity ID, kind, name, and session ID, plus edge ID,
type, source ID, and target ID.

## REQ-2 — Trusted organization scope

WHEN commercial authentication is enabled, THE SYSTEM SHALL use the API key's
organization and ignore any client-supplied `org-id`. Without commercial
authentication, THE SYSTEM SHALL require an explicit `org-id`. The database
queries SHALL each filter by the trusted organization ID.

## Acceptance criteria

- **AC-1:** a request with `limit=N` returns at most N entities (maximum 500)
  and at most 500 edges; dangling and foreign-endpoint edges are excluded.
- **AC-2:** an authenticated request cannot read another organization's graph
  by setting `org-id`, and a missing/invalid key cannot read graph data.
- **AC-3:** this API does not itself claim a graph dashboard, source ingestion,
  node summaries, or guided tours.
