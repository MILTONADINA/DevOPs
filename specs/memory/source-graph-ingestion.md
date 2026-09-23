# Project-bound source graph ingestion

**Scope:** `plan.md` §4f for project-local JavaScript and TypeScript source files in
the owner's project-local Compose stack.

## REQ-1 — Parse current source declarations and dependencies

WHEN an operator ingests a project-local source subtree, THE SYSTEM SHALL
create File nodes for supported source files, Function nodes for top-level
function declarations, and directed DECLARES and DEPENDS_ON edges from the
current source syntax. It SHALL store each node's project-relative file path
and a short source-derived summary. Repeating ingestion SHALL not duplicate
nodes or edges.

## REQ-2 — Trusted file and organization boundary

BEFORE reading source files or writing graph rows, THE SYSTEM SHALL require a
trusted project-root binding, a UUID organization ID, and the project-local
Compose API. It SHALL reject a subtree outside the project and skip symbolic
links, hidden directories, generated dependencies, and unsupported file types.
The organization ID SHALL come from the operator's process environment, not
from source text.

## Acceptance criteria

- **AC-1:** two fixture files with a relative import and two functions yield
  two File nodes, two Function nodes, two DECLARES edges, and one DEPENDS_ON
  edge with correct direction and paths.
- **AC-2:** a local database round-trip remains at the same node/edge counts
  after a second ingest and rejects an outside-root subtree.
- **AC-3:** this first parser covers JS/TS source. Cross-language parsing,
  Tier-2 fact links, model-generated summaries, and the graph dashboard remain
  open until separately verified.
