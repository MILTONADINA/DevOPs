-- Preserve the existing path-aware fuzzy ranking inside the project filter.
CREATE OR REPLACE FUNCTION public.search_project_graph_entities(
  match_org uuid, match_project_scope text, search_text text, result_limit integer
)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT e.* FROM public.knowledge_entities e
  WHERE e.org_id = match_org AND e.scope_verified
    AND e.project_scope IS NOT DISTINCT FROM match_project_scope
    AND (strpos(lower(e.name), lower(search_text)) > 0
         OR word_similarity(search_text, e.name) >= 0.3)
  ORDER BY (strpos(lower(e.name), lower(search_text)) > 0) DESC,
           word_similarity(search_text, e.name) DESC, e.name ASC
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;
