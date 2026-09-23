# Local commercial memory API binding

**Scope:** disposable integration check against the project-local Compose stack.

## REQ-1 — Authenticated organization scope

WHEN the commercial proxy serves a memory request, THE SYSTEM SHALL resolve the
organization from the active API key stored in the local database. It SHALL
return only that organization's facts, conflicts, and audit statuses, regardless
of a client-supplied `org-id` query value.

## REQ-2 — Reproducible local check

WHEN `db:verify-proxy-memory` runs, THE SYSTEM SHALL seed two disposable
organizations and keys, exercise the actual startup wiring and Fastify routes,
check missing and inactive keys, and remove its rows on success or failure.
The check SHALL use only process-supplied local Compose credentials.

## Acceptance criteria

- **AC-1:** Each key sees its own active fact, conflict, and audit status.
- **AC-2:** A foreign `org-id` query cannot redirect reads or suppression.
- **AC-3:** Missing and inactive keys are rejected; fixture rows are cleaned.
