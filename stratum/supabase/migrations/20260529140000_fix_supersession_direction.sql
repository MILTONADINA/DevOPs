-- Migration: 20260529140000_fix_supersession_direction.sql
-- Corrects the SUPERSEDES edge semantics in find_superseded (from 20260529120000).
--
-- STANDARD convention (now): a `SUPERSEDES` edge points NEWER → OLDER, i.e.
-- `from_entity SUPERSEDES to_entity` — `from` is the superseding (current) entity,
-- `to` is the superseded (stale) one. (The original function had this backwards:
-- it treated `from` as superseded, which contradicts the "A SUPERSEDES B" reading.)
--
-- find_superseded(org, names): of `names` present in the current context, which are
-- SUPERSEDED — i.e. appear as the `to` side of a SUPERSEDES edge — and by what.
-- Returns superseded = to.name, superseded_by = from.name.

CREATE OR REPLACE FUNCTION find_superseded(match_org UUID, names TEXT[])
RETURNS TABLE (superseded TEXT, superseded_by TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT et.name AS superseded, ef.name AS superseded_by
  FROM knowledge_edges e
  JOIN knowledge_entities ef ON ef.id = e.from_entity
  JOIN knowledge_entities et ON et.id = e.to_entity
  WHERE e.org_id = match_org
    AND e.edge_type = 'SUPERSEDES'
    AND et.name = ANY(names);
$$;

REVOKE EXECUTE ON FUNCTION find_superseded(UUID, TEXT[]) FROM anon, authenticated;
