# Project-wide dependency tours

**Scope:** `plan.md` §4f; organization-bound File nodes and DEPENDS_ON edges.

## REQ-1 — Traverse source graph

WHEN an operator requests File or dependency pages, THE SYSTEM SHALL return
at most 500 records per page from the API key's organization in stable keyset
order, with a next cursor when more records exist. WHERE personal mode is
active, THE SYSTEM SHALL require an explicit organization ID. IF a cursor or
limit is invalid, THEN THE SYSTEM SHALL return HTTP 400.

## REQ-2 — Guide a contributor through dependencies

WHEN an operator starts a tour from `/dashboard/graph`, THE DASHBOARD SHALL
retrieve all File and DEPENDS_ON pages, order each dependency before files
that import it, and show one file at a time with its path, source summary,
position in the tour, and Previous/Next controls. WHEN dependencies contain a
cycle, THE DASHBOARD SHALL produce a deterministic order for the remaining
files and state that a cycle affected the ordering. It SHALL render file text
as text.

## Acceptance criteria

- **AC-1:** authenticated route tests prove organization binding, bounded
  pages, cursor validation, and personal-mode organization requirement.
- **AC-2:** a local 501-file/500-edge fixture traverses every own-organization
  File and DEPENDS_ON edge in multiple pages without including foreign rows.
- **AC-3:** a browser behavior test proves dependency-first ordering, tour
  navigation, source summary display, and text-only rendering.

## Non-functional requirements

- **NFR-1:** each page contains at most 500 records; traversal does not build
  an unbounded single API response.
- **NFR-2:** the dashboard uses the same-origin memory API and the existing
  organization-bound key.

A tour reflects the graph as read across its pages; concurrent ingestion may
change it during traversal. Generated narration and semantic search are
separate gates.
