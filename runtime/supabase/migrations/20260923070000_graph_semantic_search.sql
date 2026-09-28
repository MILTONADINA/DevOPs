-- Search only live, organization-owned File and Function nodes. A dangling
-- text pointer in memory_vectors must never appear in graph search results.
CREATE OR REPLACE FUNCTION public.search_graph_semantic_entities(
  match_org uuid, query_embedding vector(384), result_limit integer
)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.*
  FROM public.memory_vectors v
  JOIN public.knowledge_entities e
    ON e.id::text = v.source_ref AND e.org_id = v.org_id
  WHERE v.org_id = match_org
    AND e.org_id = match_org
    AND v.source_type = 'entity'
    AND e.kind IN ('File', 'Function')
  ORDER BY v.embedding <=> query_embedding, e.id
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;

REVOKE EXECUTE ON FUNCTION public.search_graph_semantic_entities(uuid, vector, integer) FROM anon, authenticated;
