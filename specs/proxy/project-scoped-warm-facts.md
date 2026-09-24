# Project-scoped commercial warm facts

**Scope:** Continue `specs/proxy/trusted-project-key-scope.md` from authenticated
request binding through local memory storage and the structured fact API. This
does not activate pruning or establish project isolation for graph and other
organization-wide APIs.

## REQ-1 — Durable memory provenance

WHEN a successful commercial message with a project-bound key creates a memory
session, THE SYSTEM SHALL persist the authenticated project slug with that
session and each extracted structured fact. The database SHALL reject a fact
whose project slug differs from its owning session and SHALL reject a fact
whose organization differs from its owning session. A memory event with an
invalid or mismatched project ID SHALL fail closed before storing a session.
Existing sessions and facts SHALL remain unbound with NULL project scope.

## REQ-2 — Fact API isolation

WHEN a project-bound key reads or suppresses structured facts, THE SYSTEM
SHALL restrict the operation to that key's authenticated project within its
organization. WHEN an unbound key uses the same endpoints, THE SYSTEM SHALL
restrict it to unbound facts. A client-supplied header or query value SHALL
NOT override the authenticated scope. Personal-use calls retain their existing
organization-scoped behavior.

## REQ-3 — Scope handling in the warm adapter

WHEN a caller provides a project scope to warm-memory fact lookup, THE SYSTEM
SHALL filter before limiting results and SHALL strip the database-only project
scope from typed facts. Callers that do not provide a scope retain the existing
organization-wide internal query behavior.

## Acceptance criteria

- **AC-1:** red/green route tests prove bound, unbound, and personal behavior,
  including suppression and client spoof attempts.
- **AC-2:** red/green adapter tests prove a project filter before per-table
  limits and database-only column removal.
- **AC-3:** local database verification creates same-org, different-project
  facts through the recorder, proves their visibility and suppression boundary,
  rejects cross-session scope forgery, and cleans all fixtures.
