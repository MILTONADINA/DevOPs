-- A short symbol query needs similarity within a path, not only to the whole path.
CREATE OR REPLACE FUNCTION public.search_graph_entities(match_org uuid, search_text text, result_limit integer)
RETURNS SETOF public.knowledge_entities
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.*
  FROM public.knowledge_entities e
  WHERE e.org_id = match_org
    AND (strpos(lower(e.name), lower(search_text)) > 0
         OR word_similarity(search_text, e.name) >= 0.3)
  ORDER BY (strpos(lower(e.name), lower(search_text)) > 0) DESC,
           word_similarity(search_text, e.name) DESC, e.name ASC
  LIMIT LEAST(GREATEST(result_limit, 1), 20);
$$;
