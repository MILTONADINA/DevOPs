# In-canvas source fact nodes

**Scope:** `plan.md` §4f graph dashboard over the durable scoped File-to-fact
links. The existing related-facts API remains the source of active facts.

## REQ-1 — Render active facts beside their File

WHEN an operator selects a File in `/dashboard/graph` and its related-facts
request succeeds, THE DASHBOARD SHALL show at most 50 returned active facts as
selectable nodes in the graph canvas, each joined to that File by a visible
link. The synthetic node and link IDs SHALL be stable across repeated reads
of the same typed fact. Fact text SHALL be rendered as text, never HTML. A
selected fact SHALL show its type, summary, and File relationship.

## REQ-2 — Remove stale facts

WHEN the operator reselects a File and the related-facts response has changed,
THE DASHBOARD SHALL remove nodes and links for facts no longer returned, while
preserving other graph nodes and edges. IF the operator reloads or searches the
base graph, THEN THE DASHBOARD SHALL clear synthetic fact nodes. IF an older
response arrives after a newer selection of the same or another node, THEN
THE DASHBOARD SHALL ignore the older response. The sidebar SHALL continue to
show an empty or error state without leaving stale fact nodes visible.

## REQ-3 — Preserve source meaning

WHEN a source Function is selected, THE DASHBOARD SHALL continue to show its
related facts in the sidebar, but SHALL attach in-canvas facts only when the
indexed File node is selected. The canvas SHALL not imply a Function-to-fact
edge that the database has not established.

## Acceptance criteria

- **AC-1:** browser VM check proves a typed fact node and File link appear,
  are selectable, use text-only rendering, and do not duplicate on reselection.
- **AC-2:** browser VM check proves a refreshed empty response removes the
  fact node/link and a delayed prior response cannot restore them.
- **AC-3:** real Chrome check proves the served view can select an in-canvas
  fact node and return to its File; local graph/fact integration remains green.
