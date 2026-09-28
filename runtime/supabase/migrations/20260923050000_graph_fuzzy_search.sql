-- Fuzzy graph-name search within one organization; the API supplies its trusted org ID.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ke_name_trgm_idx ON public.knowledge_entities USING gin (name gin_trgm_ops);

CREATE FUNCTION public.search_graph_entities(match_org uuid, search_text text, result_limit integer)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.*
  FROM public.knowledge_entities e
  WHERE e.org_id = match_org
    AND (strpos(lower(e.name), lower(search_text)) > 0
         OR similarity(e.name, search_text) >= 0.2)
  ORDER BY (strpos(lower(e.name), lower(search_text)) > 0) DESC,
           similarity(e.name, search_text) DESC, e.name ASC
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;

REVOKE EXECUTE ON FUNCTION public.search_graph_entities(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_graph_entities(uuid, text, integer) TO service_role;

-- UUIDs travel in a POST body; 500 IDs in a PostgREST GET filter exceed URL limits.
CREATE FUNCTION public.list_graph_snapshot_edges(match_org uuid, entity_ids uuid[], edge_limit integer)
RETURNS TABLE(id uuid, edge_type text, from_entity uuid, to_entity uuid)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.id, e.edge_type, e.from_entity, e.to_entity
  FROM public.knowledge_edges e
  WHERE e.org_id = match_org
    AND e.from_entity = ANY(entity_ids)
    AND e.to_entity = ANY(entity_ids)
  ORDER BY e.created_at DESC
  LIMIT LEAST(GREATEST(edge_limit, 1), 500);
$$;

REVOKE EXECUTE ON FUNCTION public.list_graph_snapshot_edges(uuid, uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_graph_snapshot_edges(uuid, uuid[], integer) TO service_role;
