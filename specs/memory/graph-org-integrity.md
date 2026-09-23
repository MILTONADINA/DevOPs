# Graph organization integrity

**Scope:** the existing Tier-3 `knowledge_entities` and `knowledge_edges`
tables before source-code graph ingestion.

## REQ-1 — Same-organization graph references

WHEN a graph entity or edge references a session, THE DATABASE SHALL require
that session to belong to the same organization. WHEN an edge references its
source or target entity, THE DATABASE SHALL require each endpoint to belong
to the edge's organization. These rules SHALL apply to inserts and updates,
including service-role writes.

## REQ-2 — Migration safety

WHEN the migration is applied, THE DATABASE SHALL validate existing rows
before adding the new constraints. IF any existing graph reference crosses
organizations, the migration SHALL fail without silently deleting or
rewriting that row.

## Acceptance criteria

- **AC-1:** same-organization entity and edge references succeed.
- **AC-2:** a cross-organization source, target, or session reference fails
  with a foreign-key violation on insert or update.
- **AC-3:** the local migration applies through the project-local Compose
  runner, and a disposable API-level check removes all fixture rows.
