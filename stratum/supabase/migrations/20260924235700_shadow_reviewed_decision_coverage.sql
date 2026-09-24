-- Count facts eligible for current recall, including only non-obsolete
-- TechDecisions. The reviewed-successor rule matches SessionStart recall.
CREATE OR REPLACE FUNCTION public.find_active_fact_exchanges(
  match_org uuid, match_session uuid, match_project_scope text, exchange_ids uuid[]
)
RETURNS TABLE (exchange_id uuid, fact_count bigint)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH facts AS (
    SELECT source_exchange_id FROM public.function_changes
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT f.source_exchange_id FROM public.tech_decisions f
      WHERE f.org_id = match_org AND f.session_id = match_session
        AND f.project_scope IS NOT DISTINCT FROM match_project_scope
        AND f.source_exchange_id = ANY(exchange_ids) AND NOT f.is_suppressed
        AND NOT EXISTS (
          SELECT 1 FROM public.tech_decisions successor
          WHERE successor.org_id = match_org
            AND successor.project_scope IS NOT DISTINCT FROM match_project_scope
            AND successor.supersedes_id = f.id
            AND successor.supersession_reviewed_at IS NOT NULL
            AND NOT successor.is_suppressed
            AND successor.created_at > f.created_at
        )
    UNION ALL
    SELECT source_exchange_id FROM public.policy_updates
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id FROM public.todos
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id FROM public.variable_changes
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
    UNION ALL
    SELECT source_exchange_id FROM public.operational_references
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
  )
  SELECT facts.source_exchange_id, count(*)
  FROM facts
  WHERE EXISTS (
    SELECT 1 FROM public.sessions s WHERE s.id = match_session AND s.org_id = match_org
      AND s.kind = 'conversation' AND s.project_scope IS NOT DISTINCT FROM match_project_scope
  )
  GROUP BY facts.source_exchange_id;
$$;
REVOKE EXECUTE ON FUNCTION public.find_active_fact_exchanges(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_active_fact_exchanges(uuid, uuid, text, uuid[]) TO service_role;
