# Scoped graph semantic search

**Spec ID:** memory/graph-semantic-search  
**Status:** implementation  
**Last updated:** 2026-09-23

## REQ-1 — Offline entity embeddings

WHEN source graph ingestion writes File and Function entities, THE SYSTEM SHALL
embed their name and summary with the project-local ONNX model and upsert a
384-dimensional vector keyed by organization and entity ID. IF an entity's
summary changes, THEN the vector SHALL be replaced. The ingestion SHALL fail
without an available local model; it SHALL NOT download model data.

## REQ-2 — Scoped semantic retrieval

WHEN graph search selects semantic mode, THE SYSTEM SHALL encode the trimmed
query offline and return at most 20 ranked File or Function matches from the
authenticated organization, with the same bounded neighbors and edges as
name search. The database SHALL join vectors to existing entities within the
same organization, excluding deleted entity pointers and foreign vectors.

## REQ-3 — Input and presentation

IF mode is neither `name` nor `semantic`, or query length is outside 2–100
characters, THEN THE SYSTEM SHALL return HTTP 400. WHEN the dashboard selects
semantic mode, THE SYSTEM SHALL use the existing scoped graph search API and
render returned text as text. Name search SHALL remain the default.

## Acceptance criteria

- Route tests prove mode validation and key-bound organization scope.
- A local database fixture proves vector ranking, foreign and stale pointer
  exclusion, and bounded graph expansion.
- Offline ingestion and query encoding use only the project-local model cache;
  a missing cache fails rather than downloading.
- The dashboard exposes name and semantic modes and can select a semantic hit.
