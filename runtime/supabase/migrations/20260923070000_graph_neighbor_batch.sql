-- Search neighborhoods use a POST body for up to 200 UUIDs, avoiding long URLs.
CREATE FUNCTION public.list_graph_neighbor_entities(match_org uuid, entity_ids uuid[])
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.*
  FROM public.knowledge_entities e
  WHERE e.org_id = match_org AND e.id = ANY(entity_ids)
  LIMIT 200;
$$;

REVOKE EXECUTE ON FUNCTION public.list_graph_neighbor_entities(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_graph_neighbor_entities(uuid, uuid[]) TO service_role;
