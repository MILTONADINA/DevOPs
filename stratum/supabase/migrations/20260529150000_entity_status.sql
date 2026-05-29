-- Migration: 20260529150000_entity_status.sql
-- Tier-3 graph query powering /understand-codebase: "what is the current status of
-- entity X?" — returns every edge touching X (which direction, the edge type, and the
-- entity on the other end), so the caller can assemble: is X superseded (and by
-- what), does X supersede something, is X deprecated, what references X.
--
-- Direction (per ADR-0013 / 20260529140000): for SUPERSEDES, `from` supersedes `to`.
-- So for entity X: an 'incoming' SUPERSEDES means X is the `to` → X is SUPERSEDED by
-- `other_name`; an 'outgoing' SUPERSEDES means X is the `from` → X SUPERSEDES `other_name`.

CREATE OR REPLACE FUNCTION entity_status(match_org UUID, entity_name TEXT)
RETURNS TABLE (direction TEXT, edge_type TEXT, other_name TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT 'outgoing'::TEXT AS direction, e.edge_type, et.name AS other_name
  FROM knowledge_edges e
  JOIN knowledge_entities ef ON ef.id = e.from_entity
  JOIN knowledge_entities et ON et.id = e.to_entity
  WHERE e.org_id = match_org AND ef.name = entity_name
  UNION ALL
  SELECT 'incoming'::TEXT AS direction, e.edge_type, ef.name AS other_name
  FROM knowledge_edges e
  JOIN knowledge_entities ef ON ef.id = e.from_entity
  JOIN knowledge_entities et ON et.id = e.to_entity
  WHERE e.org_id = match_org AND et.name = entity_name;
$$;

REVOKE EXECUTE ON FUNCTION entity_status(UUID, TEXT) FROM anon, authenticated;
