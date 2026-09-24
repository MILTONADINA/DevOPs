# Project-scoped explicit sessions

**Scope:** Apply the authenticated project binding from
`specs/proxy/project-scoped-warm-facts.md` to `/v1/sessions`.

## REQ-1 — Session visibility and mutation

WHEN a commercial API key lists, reads, stats, or ends an explicit session,
THE SYSTEM SHALL operate only on sessions in that key's authenticated
organization and project slug. An unbound commercial key SHALL see only
sessions with a NULL project scope. A session outside the key's scope SHALL
return 404 for single-session operations. Client fields SHALL NOT override
the authenticated scope. Personal mode SHALL retain organization-wide access.
Internal memory and usage sessions SHALL remain hidden.

## REQ-2 — Atomic scoped creation

WHEN a commercial key creates an explicit session, THE SYSTEM SHALL persist
its authenticated project slug on that session. An unbound key SHALL create a
NULL-scoped session. THE SYSTEM SHALL enforce the plan's active explicit
session cap across the whole organization atomically, including concurrent
creates from different project keys. The response shape SHALL remain stable.

## Acceptance criteria

- **AC-1:** route and adapter tests verify bound, unbound, spoofed, and personal
  access for list, read, stats, end, and create.
- **AC-2:** a disposable local database fixture verifies two project keys and
  an unbound key cannot cross-read or end sessions, and creation persists
  scope while the organization-wide cap still applies.
