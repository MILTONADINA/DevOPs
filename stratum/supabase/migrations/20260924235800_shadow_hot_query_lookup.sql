-- Query only trusted hot exchanges before lexical matching; project-wide
-- SessionStart top-k cannot be used after its limit has hidden a hot match.
CREATE FUNCTION public.find_query_hot_fact_exchanges(
  match_org uuid, match_session uuid, match_project_scope text,
  exchange_ids uuid[], search_text text
)
RETURNS TABLE (exchange_id uuid, fact_count bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
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
  ), facts AS (
    SELECT source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(old_name, '') || ' ' || coalesce(new_name, '') || ' ' || coalesce(file_path, '') || ' ' ||
      coalesce(language, '') || ' ' || coalesce(change_type, '')) AS document
    FROM public.function_changes
    WHERE org_id = match_org AND session_id = match_session
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT f.source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(f.decision_text, '') || ' ' || coalesce(f.domain, '') || ' ' || coalesce(f.rationale, ''))
    FROM public.tech_decisions f
    WHERE f.org_id = match_org AND f.session_id = match_session
      AND f.project_scope IS NOT DISTINCT FROM match_project_scope
      AND f.source_exchange_id = ANY(exchange_ids) AND NOT f.is_suppressed
      AND NOT EXISTS (
        SELECT 1 FROM public.tech_decisions successor
        WHERE successor.org_id = match_org
          AND successor.project_scope IS NOT DISTINCT FROM match_project_scope
          AND successor.supersedes_id = f.id AND successor.supersession_reviewed_at IS NOT NULL
          AND NOT successor.is_suppressed AND successor.created_at > f.created_at
      )
    UNION ALL
    SELECT source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(policy_name, '') || ' ' || coalesce(old_value, '') || ' ' ||
      coalesce(new_value, '') || ' ' || coalesce(policy_type, ''))
    FROM public.policy_updates
    WHERE org_id = match_org AND session_id = match_session
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(description, '') || ' ' || coalesce(status, ''))
    FROM public.todos
    WHERE org_id = match_org AND session_id = match_session
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(var_name, '') || ' ' || coalesce(old_value, '') || ' ' ||
      coalesce(new_value, '') || ' ' || coalesce(context, ''))
    FROM public.variable_changes
    WHERE org_id = match_org AND session_id = match_session
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id, to_tsvector('simple'::regconfig,
      coalesce(subject, '') || ' ' || coalesce(reference, ''))
    FROM public.operational_references
    WHERE org_id = match_org AND session_id = match_session
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
  )
  SELECT facts.source_exchange_id, count(*)
  FROM facts CROSS JOIN query q
  WHERE cardinality(exchange_ids) BETWEEN 1 AND 128
    AND q.terms IS NOT NULL AND facts.document @@ q.terms
    AND EXISTS (
      SELECT 1 FROM public.sessions s WHERE s.id = match_session AND s.org_id = match_org
        AND s.kind = 'conversation' AND s.project_scope IS NOT DISTINCT FROM match_project_scope
    )
  GROUP BY facts.source_exchange_id;
$$;
REVOKE EXECUTE ON FUNCTION public.find_query_hot_fact_exchanges(uuid, uuid, text, uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_query_hot_fact_exchanges(uuid, uuid, text, uuid[], text)
  TO service_role;
