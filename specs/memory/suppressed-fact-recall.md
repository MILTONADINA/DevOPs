# Suppressed fact recall guard

**Scope:** v0.5 warm/cold recall and v0.6 audit suppression, as described in
`stratum/docs/MEMORY_ARCHITECTURE.md` and `stratum/docs/AUDIT_ENGINE.md`.

## REQ-1 — Recall exclusion

WHEN a fact has `is_suppressed = true`, THE SYSTEM SHALL exclude it from recent
warm-memory recall and from content-free vector-hit resolution. It SHALL not
be promoted from Tier 2 to Tier 3 while suppressed.

WHEN a semantic CLI query encounters a vector pointer whose fact cannot be
resolved to an active typed row, THE SYSTEM SHALL omit that fact hit from its
output rather than print an unresolved pointer into agent context.

## REQ-2 — Durable suppression

WHEN an already persisted fact is replayed by the eviction drain after a
transient write failure, THE SYSTEM SHALL retain the existing database row's
suppression and verification fields. A retry SHALL NOT clear suppression or
create a duplicate fact.

## Acceptance criteria

- **AC-1:** suppressed rows are absent from all three warm read paths.
- **AC-2:** a retry of a suppressed fact preserves `is_suppressed = true`.
- **AC-3:** active facts remain available and cross-organization reads remain
  scoped to the trusted organization.
- **AC-4:** the `/understand-codebase` query and entity-neighbour modes omit
  unresolved fact pointers while retaining active resolved neighbours.
