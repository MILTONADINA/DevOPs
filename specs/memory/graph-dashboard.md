# Scoped graph dashboard

**Scope:** `plan.md` §4f, first browser view of the existing bounded graph API.

## REQ-1 — Render a scoped graph

WHEN an operator opens `/dashboard/graph`, THE SYSTEM SHALL serve a standalone
vanilla browser view that loads `/v1/memory/graph?limit=500` using the CQ key
entered by the operator, or a project-local `org-id` query in personal mode.
It SHALL show the returned nodes and edges, support pan, zoom, node selection,
and show the selected node's type, path, summary, and relationships. It SHALL
render graph text as text, never as HTML.

## REQ-2 — Visible limits and safe failures

WHEN no scope is provided, authentication fails, or the bounded API fails,
THE SYSTEM SHALL show a useful status in the view. WHEN 500 nodes are returned,
THE SYSTEM SHALL state that the snapshot may be truncated.

## Acceptance criteria

- **AC-1:** the route serves a CSP-protected HTML shell that requests only the
  existing scoped graph API.
- **AC-2:** the browser view supports a selected node details sidebar, pan,
  zoom, and click-to-expand neighbors from the loaded snapshot.
- **AC-3:** no graph-supplied value is inserted with `innerHTML`.

Pagination, fuzzy/semantic search, tours, Tier-2 links, and model-generated
summaries remain separate work.
