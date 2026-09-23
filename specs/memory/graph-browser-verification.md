# Real-browser graph verification

**Scope:** `plan.md` §4f graph dashboard and guided tour.

## REQ-1 — Exercise the served view in Chrome

WHEN an operator runs the graph browser check with local Chrome installed, THE
SYSTEM SHALL serve the actual dashboard and scoped API from a loopback Fastify
instance, then use Chrome to load the graph, select a File, search, and navigate
the dependency-order tour. The check SHALL require a related Tier-2 fact to
render as text and SHALL save a project-local screenshot.

## REQ-2 — Keep the check isolated

THE CHECK SHALL use disposable in-memory API fixtures, bind only to loopback,
write its Chrome profile and screenshot only inside this project, and close the
browser and server whether verification passes or fails.

## Acceptance criteria

- **AC-1:** Chrome reports two graph nodes, shows the selected File path and
  literal hostile fact text without creating an image, and finds the searched
  node.
- **AC-2:** the tour visits the dependency before its importer and advances
  with Next.
- **AC-3:** a screenshot exists in `.workflow/proofs/`; no external service or
  database is needed.
