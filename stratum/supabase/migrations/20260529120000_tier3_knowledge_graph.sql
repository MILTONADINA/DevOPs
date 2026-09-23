-- Migration: 20260529120000_tier3_knowledge_graph.sql
-- Tier-3 cold memory — knowledge graph (relational implementation on Supabase).
-- Per ADR-0013: implements the blueprint's Tier-3 graph on Postgres instead of
-- Neo4j (no Neo4j account available; the live Supabase project is). The pruner's
-- ADR-0011 supersession fix reads SUPERSEDES edges from here. Swappable for Neo4j
-- behind the ColdMemory/KnowledgeGraph interface (src/memory/cold/graph.ts).
--
-- Spelling note: the blueprint/CLAUDE.md write the edge "SUPERCEDES"; this uses the
-- correct English "SUPERSEDES", consistent with tech_decisions.supersedes_id + ADR-0011.

-- ─── Knowledge Entities ───────────────────────────────────────────────────────
-- Node kinds per CLAUDE.md (+ Project): Function, Commit, Decision, Developer, Policy, Project.

CREATE TABLE knowledge_entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES sessions(id),
  kind        TEXT NOT NULL
              CHECK (kind IN ('Function', 'Commit', 'Decision', 'Developer', 'Policy', 'Project')),
  name        TEXT NOT NULL,
  -- An entity is identified by (org, kind, name) — enables create-or-get.
  UNIQUE (org_id, kind, name)
);

CREATE INDEX ke_org_kind_name_idx ON knowledge_entities(org_id, kind, name);

-- ─── Knowledge Edges ──────────────────────────────────────────────────────────
-- Edge types per CLAUDE.md (SUPERSEDES spelling corrected): SUPERSEDES,
-- DEPRECATED_BY, REFERENCED_IN, AUTHORED_BY, APPLIES_TO.

CREATE TABLE knowledge_edges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_entity  UUID NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  to_entity    UUID NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  edge_type    TEXT NOT NULL
               CHECK (edge_type IN ('SUPERSEDES', 'DEPRECATED_BY', 'REFERENCED_IN', 'AUTHORED_BY', 'APPLIES_TO')),
  session_id   UUID REFERENCES sessions(id),
  -- One edge of a given type between two entities.
  UNIQUE (from_entity, to_entity, edge_type),
  CHECK (from_entity <> to_entity)
);

CREATE INDEX kedge_org_type_idx ON knowledge_edges(org_id, edge_type);
CREATE INDEX kedge_from_idx ON knowledge_edges(from_entity);
CREATE INDEX kedge_to_idx ON knowledge_edges(to_entity);

-- ─── Supersession query (ADR-0011 primary fix) ────────────────────────────────
-- Of the given entity names, which are SUPERSEDED (have an outgoing SUPERSEDES
-- edge) and by what. The pruner suppresses a selected turn whose entity is
-- `superseded` when the `superseded_by` entity is also present/more-recent.
-- SECURITY INVOKER (default) + RLS on the tables; EXECUTE revoked from anon/
-- authenticated so only the service role calls it.

CREATE OR REPLACE FUNCTION find_superseded(match_org UUID, names TEXT[])
RETURNS TABLE (superseded TEXT, superseded_by TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT ef.name AS superseded, et.name AS superseded_by
  FROM knowledge_edges e
  JOIN knowledge_entities ef ON ef.id = e.from_entity
  JOIN knowledge_entities et ON et.id = e.to_entity
  WHERE e.org_id = match_org
    AND e.edge_type = 'SUPERSEDES'
    AND ef.name = ANY(names);
$$;

REVOKE EXECUTE ON FUNCTION find_superseded(UUID, TEXT[]) FROM anon, authenticated;
