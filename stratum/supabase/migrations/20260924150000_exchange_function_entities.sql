-- A selected commercial exchange identifies a Function entity only if its
-- active facts agree on one name in the exact verified conversation binding.
CREATE FUNCTION public.find_exchange_function_entities(
  match_org uuid, match_session uuid, match_project_scope text, exchange_ids uuid[]
)
RETURNS TABLE (exchange_id uuid, entity_name text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT f.source_exchange_id, min(coalesce(nullif(f.new_name, ''), f.old_name))
  FROM public.function_changes f
  JOIN public.sessions s ON s.id = f.session_id AND s.org_id = f.org_id
  WHERE f.org_id = match_org AND f.session_id = match_session
    AND s.kind = 'conversation'
    AND s.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.source_exchange_id = ANY(exchange_ids)
    AND NOT f.is_suppressed
  GROUP BY f.source_exchange_id
  HAVING bool_and(coalesce(nullif(f.new_name, ''), f.old_name) <> '')
    AND count(DISTINCT coalesce(nullif(f.new_name, ''), f.old_name)) = 1;
$$;
REVOKE EXECUTE ON FUNCTION public.find_exchange_function_entities(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_exchange_function_entities(uuid, uuid, text, uuid[]) TO service_role;
