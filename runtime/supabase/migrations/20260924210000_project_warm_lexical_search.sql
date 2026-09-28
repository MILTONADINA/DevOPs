-- A bounded candidate source for old typed facts. The local encoder still
-- decides relevance; lexical rank only selects rows beyond the newest 200.
CREATE FUNCTION public.search_project_warm_facts(
  match_org uuid, match_project_scope text, search_text text, result_limit integer
)
RETURNS TABLE (fact_table text, fact jsonb, lexical_score real)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  WITH tokens AS (
    SELECT word FROM (
      SELECT (regexp_matches(lower(left(coalesce(search_text, ''), 1200)), '[a-z0-9_]+', 'g'))[1] AS word
    ) t
    WHERE length(word) >= 3
      AND word NOT IN ('the', 'and', 'for', 'from', 'with', 'that', 'this',
        'which', 'what', 'where', 'when', 'how', 'are', 'was', 'were', 'does',
        'have', 'has', 'its', 'our', 'their', 'into', 'about', 'should')
    LIMIT 16
  ), query AS (
    SELECT to_tsquery('simple', coalesce(string_agg(word, ' | '), '')) AS terms FROM tokens
  ), scoped AS (
    SELECT 'function_changes'::text AS source, to_jsonb(f) AS body,
      to_tsvector('simple', concat_ws(' ', f.old_name, f.new_name, f.file_path, f.language, f.change_type)) AS document
    FROM public.function_changes f
    WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
    UNION ALL
    SELECT 'tech_decisions', to_jsonb(f),
      to_tsvector('simple', concat_ws(' ', f.decision_text, f.domain, f.rationale))
    FROM public.tech_decisions f
    WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
      AND NOT EXISTS (
        SELECT 1 FROM public.tech_decisions successor
        WHERE successor.org_id = match_org AND successor.project_scope IS NOT DISTINCT FROM match_project_scope
          AND successor.supersedes_id = f.id AND successor.supersession_reviewed_at IS NOT NULL
          AND NOT successor.is_suppressed AND successor.created_at > f.created_at
      )
    UNION ALL
    SELECT 'policy_updates', to_jsonb(f),
      to_tsvector('simple', concat_ws(' ', f.policy_name, f.old_value, f.new_value, f.policy_type))
    FROM public.policy_updates f
    WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
    UNION ALL
    SELECT 'todos', to_jsonb(f),
      to_tsvector('simple', concat_ws(' ', f.description, f.status))
    FROM public.todos f
    WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
    UNION ALL
    SELECT 'variable_changes', to_jsonb(f),
      to_tsvector('simple', concat_ws(' ', f.var_name, f.old_value, f.new_value, f.context))
    FROM public.variable_changes f
    WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
  )
  SELECT scoped.source, scoped.body, ts_rank_cd(scoped.document, query.terms)::real
  FROM scoped CROSS JOIN query
  WHERE scoped.document @@ query.terms
  ORDER BY ts_rank_cd(scoped.document, query.terms) DESC,
    (scoped.body->>'created_at') DESC, (scoped.body->>'id')
  LIMIT GREATEST(0, LEAST(coalesce(result_limit, 0), 20));
$$;

REVOKE EXECUTE ON FUNCTION public.search_project_warm_facts(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_project_warm_facts(uuid, text, text, integer)
  TO service_role;
