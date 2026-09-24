-- Match the RPC's immutable text expressions so selective project searches
-- can use GIN rather than rebuilding a vector for every scoped fact.
CREATE INDEX fc_warm_lexical_gin_idx ON public.function_changes USING gin (
  to_tsvector('simple'::regconfig, coalesce(old_name, '') || ' ' || coalesce(new_name, '') || ' ' ||
    coalesce(file_path, '') || ' ' || coalesce(language, '') || ' ' || coalesce(change_type, ''))
) WHERE NOT is_suppressed;
CREATE INDEX td_warm_lexical_gin_idx ON public.tech_decisions USING gin (
  to_tsvector('simple'::regconfig, coalesce(decision_text, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(rationale, ''))
) WHERE NOT is_suppressed;
CREATE INDEX pu_warm_lexical_gin_idx ON public.policy_updates USING gin (
  to_tsvector('simple'::regconfig, coalesce(policy_name, '') || ' ' || coalesce(old_value, '') || ' ' ||
    coalesce(new_value, '') || ' ' || coalesce(policy_type, ''))
) WHERE NOT is_suppressed;
CREATE INDEX todos_warm_lexical_gin_idx ON public.todos USING gin (
  to_tsvector('simple'::regconfig, coalesce(description, '') || ' ' || coalesce(status, ''))
) WHERE NOT is_suppressed;
CREATE INDEX vc_warm_lexical_gin_idx ON public.variable_changes USING gin (
  to_tsvector('simple'::regconfig, coalesce(var_name, '') || ' ' || coalesce(old_value, '') || ' ' ||
    coalesce(new_value, '') || ' ' || coalesce(context, ''))
) WHERE NOT is_suppressed;

CREATE OR REPLACE FUNCTION public.search_project_warm_facts(
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
  ), scored AS (
    SELECT 'function_changes'::text AS source, to_jsonb(hit.fact_row) AS body, hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.old_name, '') || ' ' || coalesce(f.new_name, '') || ' ' || coalesce(f.file_path, '') || ' ' ||
        coalesce(f.language, '') || ' ' || coalesce(f.change_type, '')), q.terms)::real AS score
      FROM public.function_changes f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig, coalesce(f.old_name, '') || ' ' || coalesce(f.new_name, '') || ' ' ||
          coalesce(f.file_path, '') || ' ' || coalesce(f.language, '') || ' ' || coalesce(f.change_type, '')) @@ q.terms
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
    UNION ALL
    SELECT 'tech_decisions', to_jsonb(hit.fact_row), hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.decision_text, '') || ' ' || coalesce(f.domain, '') || ' ' || coalesce(f.rationale, '')), q.terms)::real AS score
      FROM public.tech_decisions f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig, coalesce(f.decision_text, '') || ' ' || coalesce(f.domain, '') || ' ' || coalesce(f.rationale, '')) @@ q.terms
        AND NOT EXISTS (
          SELECT 1 FROM public.tech_decisions successor
          WHERE successor.org_id = match_org AND successor.project_scope IS NOT DISTINCT FROM match_project_scope
            AND successor.supersedes_id = f.id AND successor.supersession_reviewed_at IS NOT NULL
            AND NOT successor.is_suppressed AND successor.created_at > f.created_at
        )
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
    UNION ALL
    SELECT 'policy_updates', to_jsonb(hit.fact_row), hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.policy_name, '') || ' ' || coalesce(f.old_value, '') || ' ' || coalesce(f.new_value, '') || ' ' ||
        coalesce(f.policy_type, '')), q.terms)::real AS score
      FROM public.policy_updates f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig, coalesce(f.policy_name, '') || ' ' || coalesce(f.old_value, '') || ' ' ||
          coalesce(f.new_value, '') || ' ' || coalesce(f.policy_type, '')) @@ q.terms
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
    UNION ALL
    SELECT 'todos', to_jsonb(hit.fact_row), hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.description, '') || ' ' || coalesce(f.status, '')), q.terms)::real AS score
      FROM public.todos f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig, coalesce(f.description, '') || ' ' || coalesce(f.status, '')) @@ q.terms
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
    UNION ALL
    SELECT 'variable_changes', to_jsonb(hit.fact_row), hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.var_name, '') || ' ' || coalesce(f.old_value, '') || ' ' || coalesce(f.new_value, '') || ' ' ||
        coalesce(f.context, '')), q.terms)::real AS score
      FROM public.variable_changes f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig, coalesce(f.var_name, '') || ' ' || coalesce(f.old_value, '') || ' ' ||
          coalesce(f.new_value, '') || ' ' || coalesce(f.context, '')) @@ q.terms
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
  )
  SELECT scored.source, scored.body, scored.score
  FROM scored
  ORDER BY scored.score DESC,
    (scored.body->>'created_at') DESC, (scored.body->>'id')
  LIMIT GREATEST(0, LEAST(coalesce(result_limit, 0), 20));
$$;
