# Project-scoped commercial audit reads

**Scope:** Continue the authenticated project binding in
`specs/proxy/project-scoped-warm-facts.md` through the conflict and audit-status
read endpoints. This does not change graph or explicit-session APIs.

## REQ-1 — Provenance-based audit scope

WHEN a commercial key reads `/v1/memory/conflicts` or
`/v1/memory/audit-statuses`, THE SYSTEM SHALL return only rows whose referenced
typed fact belongs to that key's authenticated organization and project slug.
An unbound key SHALL see only audit rows for unbound facts. Client headers and
query parameters SHALL NOT override the authenticated scope. Rows with missing
or mismatched fact provenance SHALL NOT be returned.

## REQ-2 — Filter before limit

WHEN either audit endpoint applies a result limit, THE DATABASE SHALL filter
by organization and project provenance before sorting and limiting. Personal
mode SHALL keep its existing organization-scoped behavior. Existing audit
write semantics and fact suppression SHALL remain unchanged.

## Acceptance criteria

- **AC-1:** red/green route tests prove bound and unbound keys pass only their
  authenticated scope while personal calls remain organization-scoped.
- **AC-2:** a disposable local database check creates two projects in one
  organization, confirms their conflict/status rows cannot cross keys even
  with a spoofed client scope, verifies limit-before-leak behavior and missing
  fact exclusion, then removes all fixture rows.
