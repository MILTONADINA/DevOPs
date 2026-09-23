# Local request-path fact survival

**Scope:** v0.5 memory ship evidence on the project-local Compose API.

## REQ-1 — Fifty later turns

WHEN a disposable authenticated request yields one validated durable fact,
THE SYSTEM SHALL retain that fact through fifty later successful message
requests that yield no related facts. The requests SHALL use the actual
commercial proxy startup wiring and a loopback test extraction model.

## REQ-2 — SessionStart recall and cleanup

AFTER those fifty later requests, THE SYSTEM SHALL retrieve the first fact
through the actual project-bound SessionStart bridge with the owning
organization. It SHALL find no unrelated facts and remove the disposable
organization, keys, sessions, and facts after verification or failure.

## Acceptance criteria

- **AC-1:** fifty-one successful authenticated `/v1/messages` requests create
  fifty-one isolated memory sessions and exactly one typed fact.
- **AC-2:** the SessionStart bridge returns that fact after request 51, with
  no credential or unrelated turn text.
- **AC-3:** the check uses only a loopback fake extraction model. It is local
  pipeline evidence, not a live Claude hook or real-model quality result.
