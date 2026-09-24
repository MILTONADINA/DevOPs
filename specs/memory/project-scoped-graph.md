# Project-scoped commercial graph

**Scope:** Extend the authenticated project binding to Tier-3 graph storage and
the five `/v1/memory/graph*` read endpoints. Personal mode keeps its existing
organization-wide graph.

## REQ-1 — Project identity at graph write time

WHEN a trusted fact session is promoted, THE SYSTEM SHALL create or reuse
entities and edges only within that session's project slug. WHEN the operator
indexes source files, THE SYSTEM SHALL use a validated project slug supplied
through the trusted operator environment; without one it SHALL index the
unbound project. Same-name nodes from two projects SHALL have distinct IDs and
independent metadata. An edge SHALL connect only nodes in the same project.
Session provenance links and source-to-fact links SHALL reject a project
mismatch. The organization-wide node and edge limits SHALL remain bounded.

## REQ-2 — Uncertain historical provenance

GIVEN graph rows created before trustworthy project identity was stored, THE
SYSTEM SHALL treat those rows as provenance-uncertain. Commercial graph reads
SHALL omit them for both bound and unbound keys. New scoped writes SHALL NOT
reuse uncertain rows. Personal mode SHALL retain organization-wide reads of
historical rows. The migration SHALL NOT invent a project for old rows.

## REQ-3 — Project-bound graph reads

WHEN a commercial key requests a graph snapshot, name or semantic search,
File page, dependency page, or related facts, THE SYSTEM SHALL filter entities,
edges, vectors, and linked facts to the key's authenticated project before
sorting, limiting, or expansion. An unbound key SHALL see only verified
NULL-scoped rows. Client query fields and headers SHALL NOT override the key.
A cross-project File path SHALL return 404 to related-facts lookup. Search
expansion SHALL omit foreign neighbors and edges. Personal mode SHALL preserve
the current organization-wide behavior.

## Acceptance criteria

- **AC-1:** a red/green adapter test shows same-name nodes remain distinct
  across project slugs; a local SQL fixture rejects cross-project edges and
  provenance links and quarantines historical rows.
- **AC-2:** a local three-key fixture verifies every graph endpoint, including
  limits, search expansion, exact File matches, and spoofed client scope.
- **AC-3:** existing personal graph and promotion fixtures continue to pass.
