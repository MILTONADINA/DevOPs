-- Migration: 20260530010000_memory_vectors_dedup.sql
-- Fixes a data-integrity defect (Session-20 adversarial review): VectorStore.upsert() issued a plain
-- INSERT, so a re-run of the warm→cold promotion job (crash between vector write + markPromoted, or a
-- manual re-run) re-inserted DUPLICATE vector rows for the same fact — bloating the HNSW index and
-- returning the same source_ref multiple times in semantic recall (the job documents itself idempotent).
--
-- A unique index on (org_id, source_type, source_ref) lets the write become a true upsert (ON CONFLICT
-- DO NOTHING). Postgres treats NULLs as DISTINCT by default, so source_ref-less rows (non-promotion
-- inserts) are unaffected (multiple allowed); only repeated promotions of the SAME fact are deduped.

CREATE UNIQUE INDEX IF NOT EXISTS memory_vectors_org_source_uq
  ON memory_vectors (org_id, source_type, source_ref);
