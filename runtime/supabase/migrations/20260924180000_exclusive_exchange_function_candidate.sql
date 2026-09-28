-- A Function rename is only a shadow candidate when the selected exchange
-- has exactly one active FunctionChange and no other active typed fact. The
-- absence of other extracted facts still does not prove dialogue-turn safety.
CREATE OR REPLACE FUNCTION public.find_exchange_function_entities(
  match_org uuid, match_session uuid, match_project_scope text, exchange_ids uuid[]
)
RETURNS TABLE (exchange_id uuid, entity_name text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH other_facts AS (
    SELECT source_exchange_id FROM public.tech_decisions
      WHERE org_id = match_org AND session_id = match_session
        AND project_scope IS NOT DISTINCT FROM match_project_scope
        AND source_exchange_id = ANY(exchange_ids) AND NOT is_suppressed
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
  )
  SELECT f.source_exchange_id, min(coalesce(nullif(f.new_name, ''), f.old_name))
  FROM public.function_changes f
  JOIN public.sessions s ON s.id = f.session_id AND s.org_id = f.org_id
  WHERE f.org_id = match_org AND f.session_id = match_session
    AND s.kind = 'conversation'
    AND s.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.source_exchange_id = ANY(exchange_ids)
    AND NOT f.is_suppressed
    AND NOT EXISTS (SELECT 1 FROM other_facts extra WHERE extra.source_exchange_id = f.source_exchange_id)
  GROUP BY f.source_exchange_id
  HAVING count(*) = 1
    AND bool_and(coalesce(nullif(f.new_name, ''), f.old_name) <> '');
$$;
REVOKE EXECUTE ON FUNCTION public.find_exchange_function_entities(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_exchange_function_entities(uuid, uuid, text, uuid[]) TO service_role;
