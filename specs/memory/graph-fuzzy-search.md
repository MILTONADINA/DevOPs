# Scoped graph fuzzy search

**Spec ID:** memory/graph-fuzzy-search

**Status:** implementation
**Last updated:** 2026-09-23

## Context

The graph dashboard reads at most 500 recent nodes. An operator must be able
to find a known entity elsewhere in the organization graph, including when a
name is slightly misspelled, and inspect its immediate relationships.

## REQ-1 — Find organization graph nodes

WHEN an authenticated operator searches graph names, THE SYSTEM SHALL return
at most 20 ranked matches from the operator's organization, including matches
outside the recent graph snapshot. A literal substring SHALL rank above a
similar spelling. THE SYSTEM SHALL return matched nodes with their immediate
inbound and outbound relationships and the related endpoint nodes, within a
bounded response.

## REQ-2 — Validate scope and input

IF the search text is shorter than two characters or longer than 100 characters
after trimming, THEN THE SYSTEM SHALL reject it with HTTP 400. WHILE
commercial authentication is enforced, THE SYSTEM SHALL ignore any supplied
`org-id` and use the organization bound to the API key. WHERE personal mode is
active, THE SYSTEM SHALL require an explicit organization ID.

## REQ-3 — Find from the graph view

WHEN the operator submits graph search, THE DASHBOARD SHALL show returned nodes
and allow selecting a match to see its path, summary, and immediate
relationships. It SHALL render returned text as text.

## Acceptance criteria

- **AC-1:** route tests prove input validation, 20-result cap, and auth scope.
- **AC-2:** a local database test finds a node outside the 500-node snapshot,
  ranks a substring ahead of a similar spelling, returns its edge and neighbor,
  and excludes a foreign organization's matching node.
- **AC-3:** a browser behavior test proves a searched result can be selected
  without interpreting its name as HTML.

## Non-functional requirements

- **NFR-1:** the search response contains no more than 20 matches, 200 edges,
  and 220 nodes, irrespective of graph size.
- **NFR-2:** graph results use only the existing same-origin API and existing
  key-based organization binding.

Semantic embedding search is a separate gate. This feature does not claim that
source node summaries or Tier-2 links are complete.
