# Project-scoped SessionStart recall

**Scope:** Continue `specs/memory/session-start-recall.md` and
`specs/proxy/project-scoped-warm-facts.md` for the local SessionStart bridge.
This does not activate pruning or change commercial graph API scope.

## REQ-1 — Operator project binding

WHEN the SessionStart bridge runs, THE SYSTEM SHALL accept a project slug only
from the operator's `DEVOPS_STRATUM_PROJECT_SCOPE` process environment. It
SHALL validate the same lowercase slug syntax as commercial API keys and skip
recall before creating a client if the value is invalid. An absent slug SHALL
select only legacy unbound facts. The bound project root, organization ID,
allowlist, and service credential requirements remain in force.

## REQ-2 — Scoped recent and semantic facts

WHEN the bridge retrieves recent facts, THE SYSTEM SHALL filter by
organization and exact project scope before applying its limit. WHEN it
retrieves semantic facts, THE SYSTEM SHALL rank only active fact vectors whose
source facts belong to that same organization and project scope before
applying its limit, then resolve references with the same scope check. A
foreign project, suppressed fact, or dangling vector SHALL NOT appear in
the emitted context. A missing encoder SHALL still allow scoped recent recall.

## Acceptance criteria

- **AC-1:** a focused red/green test proves invalid scope makes no client call
  and that bound, unbound, and foreign facts cannot cross the bridge output.
- **AC-2:** a local database check creates same-org different-project facts
  and vectors, verifies scoped semantic ranking before the limit and the
  actual bridge entry point's recent output, then cleans all fixture rows.
- **AC-3:** existing local unbound SessionStart recall still works with no
  project slug, and typecheck and targeted lint pass.
