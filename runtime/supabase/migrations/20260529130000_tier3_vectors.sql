-- Migration: 20260529130000_tier3_vectors.sql
-- Tier-3 cold memory — vector store (pgvector on Supabase). Per ADR-0013, the
-- blueprint's Pinecone role is served by pgvector on the live Supabase project,
-- behind the VectorStore interface (src/memory/cold/vectors.ts) so Pinecone can
-- swap in later.
--
-- CONSTITUTION ("Do not store raw unencrypted context in Supabase/Pinecone"):
-- this table stores ONLY the embedding + a pointer (source_type/source_ref) to the
-- typed row it was derived from — NO plaintext content. Recall resolves content
-- from the typed Tier-2 fact tables via source_ref. An all-MiniLM-L6-v2 embedding
-- is a lossy 384-d projection, not reconstructable raw context.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_vectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id),
  source_type   TEXT NOT NULL CHECK (source_type IN ('fact', 'turn', 'entity')),
  source_ref    TEXT,            -- pointer to the source row (e.g. a fact id); NOT content
  embedding     VECTOR(384) NOT NULL  -- all-MiniLM-L6-v2 dim (matches src/pruner/encoder.ts)
);

CREATE INDEX memvec_org_idx ON memory_vectors(org_id);
-- HNSW + cosine ops for approximate nearest-neighbour recall.
CREATE INDEX memvec_embedding_idx ON memory_vectors USING hnsw (embedding vector_cosine_ops);

-- Cosine-similarity search within an org. `<=>` is cosine DISTANCE; similarity = 1 - distance.
CREATE OR REPLACE FUNCTION match_memory_vectors(query_embedding VECTOR(384), match_org UUID, match_count INT)
RETURNS TABLE (id UUID, source_type TEXT, source_ref TEXT, similarity FLOAT)
LANGUAGE sql
STABLE
AS $$
  SELECT mv.id, mv.source_type, mv.source_ref,
         1 - (mv.embedding <=> query_embedding) AS similarity
  FROM memory_vectors mv
  WHERE mv.org_id = match_org
  ORDER BY mv.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION match_memory_vectors(vector, uuid, integer) FROM anon, authenticated;
