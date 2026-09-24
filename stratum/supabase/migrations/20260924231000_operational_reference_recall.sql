-- Add the sixth typed source to the bounded exact-project lexical search.
CREATE INDEX operational_references_warm_lexical_gin_idx
  ON public.operational_references USING gin (
    to_tsvector('simple'::regconfig, coalesce(subject, '') || ' ' || coalesce(reference, ''))
  ) WHERE NOT is_suppressed;

-- Preserve dots, slashes, colons, and dashes in operator references. Let the
-- PostgreSQL text parser escape each token before joining them as an OR query.
CREATE OR REPLACE FUNCTION public.search_project_warm_facts(
  match_org uuid, match_project_scope text, search_text text, result_limit integer
)
RETURNS TABLE (fact_table text, fact jsonb, lexical_score real)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  WITH tokens AS (
    SELECT word FROM (
      SELECT (regexp_matches(lower(left(coalesce(search_text, ''), 1200)), '[a-z0-9_./:-]+', 'g'))[1] AS word
    ) t
    WHERE length(word) >= 3 AND word ~ '[a-z0-9_]'
      AND word NOT IN ('the', 'and', 'for', 'from', 'with', 'that', 'this',
        'which', 'what', 'where', 'when', 'how', 'are', 'was', 'were', 'does',
        'have', 'has', 'its', 'our', 'their', 'into', 'about', 'should')
    LIMIT 16
  ), query AS (
    SELECT string_agg(plainto_tsquery('simple', word)::text, ' | ')::tsquery AS terms FROM tokens
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
    UNION ALL
    SELECT 'operational_references', to_jsonb(hit.fact_row), hit.score
    FROM query q CROSS JOIN LATERAL (
      SELECT f AS fact_row, ts_rank_cd(to_tsvector('simple'::regconfig,
        coalesce(f.subject, '') || ' ' || coalesce(f.reference, '')), q.terms)::real AS score
      FROM public.operational_references f
      WHERE f.org_id = match_org AND f.project_scope IS NOT DISTINCT FROM match_project_scope AND NOT f.is_suppressed
        AND to_tsvector('simple'::regconfig,
          coalesce(f.subject, '') || ' ' || coalesce(f.reference, '')) @@ q.terms
      ORDER BY score DESC, f.created_at DESC, f.id LIMIT 20
    ) hit
  )
  SELECT scored.source, scored.body, scored.score
  FROM scored
  ORDER BY scored.score DESC,
    (scored.body->>'created_at') DESC, (scored.body->>'id')
  LIMIT GREATEST(0, LEAST(coalesce(result_limit, 0), 20));
$$;

-- SessionStart ranks vectors only after joining to active facts in the bound
-- project. Filtering resolved refs after an org-wide LIMIT could starve recall.
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
    SELECT id::text FROM public.tech_decisions
      WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope AND NOT is_suppressed
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
