# Local Tier-2 to Tier-3 promotion

**Scope:** `plan.md` §4d and the approved local Compose development stack.

## REQ-1 — Process-bound offline promotion

WHEN an operator runs the promotion CLI against the local Compose API, THE
SYSTEM SHALL read the API URL and service key from its process environment,
SHALL NOT load `.env`, and SHALL prevent the encoder from downloading a model.
WHEN a project-local encoder cache is absent, THE SYSTEM SHALL fail without a
remote model request or marking any fact promoted.

## REQ-2 — Scoped development verification

WHEN the local promotion check creates a disposable organization and typed
facts, THE SYSTEM SHALL promote only its active facts into graph and vector
records, leave a suppressed fact unpromoted, prove an entity status query
through the bound `/understand-codebase` adapter, and remove all fixture rows.
The local check SHALL NOT be treated as evidence of nightly scheduling or a
deployed v0.5 latency gate.

## Acceptance criteria

- **AC-1:** the promotion path has no `.env` read and disables remote models
  before encoding any fact.
- **AC-2:** the local fixture's active function change yields a graph
  `SUPERSEDES` edge and a fact vector, while a suppressed fact remains
  unpromoted.
- **AC-3:** the bound read command reports the promoted entity relationship
  for the disposable organization, and the fixture is removed afterward.
