-- Filter reviewed superseded decisions before the vector top-k limit.
-- The SessionStart recent window cannot identify successors beyond its cap.
CREATE OR REPLACE FUNCTION public.match_project_fact_vectors(
  query_embedding vector(384), match_org uuid, match_project_scope text, match_count integer
)
RETURNS TABLE (id uuid, source_type text, source_ref text, similarity float)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  WITH scoped_refs AS (
    SELECT id::text AS ref FROM public.function_changes
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
    UNION
    SELECT f.id::text FROM public.tech_decisions f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND NOT EXISTS (
          SELECT 1 FROM public.tech_decisions successor
          WHERE successor.org_id = match_org
            AND successor.project_scope IS NOT DISTINCT FROM match_project_scope
            AND successor.supersedes_id = f.id
            AND successor.supersession_reviewed_at IS NOT NULL
            AND NOT successor.is_suppressed
            AND successor.created_at > f.created_at
        )
    UNION
    SELECT id::text FROM public.policy_updates
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
    UNION
    SELECT id::text FROM public.todos
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
    UNION
    SELECT id::text FROM public.variable_changes
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
    UNION
    SELECT id::text FROM public.operational_references
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
  )
  SELECT mv.id, mv.source_type, mv.source_ref,
         (1 - (mv.embedding <=> query_embedding))::float AS similarity
  FROM public.memory_vectors mv
  JOIN scoped_refs f ON f.ref = mv.source_ref
  WHERE mv.org_id = match_org AND mv.source_type = 'fact'
  ORDER BY mv.embedding <=> query_embedding
  LIMIT GREATEST(0, LEAST(match_count, 50));
$$;

REVOKE EXECUTE ON FUNCTION public.match_project_fact_vectors(vector, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_project_fact_vectors(vector, uuid, text, integer)
  TO service_role;
