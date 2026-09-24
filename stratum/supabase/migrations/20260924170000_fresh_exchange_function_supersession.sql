-- A new rename can be observed inside the hot window, before the 30-day
-- Tier-3 promotion cutoff. Only active facts from selected exchanges count.
CREATE FUNCTION public.find_fresh_exchange_function_superseded(
  match_org uuid, match_session uuid, match_project_scope text, exchange_ids uuid[]
)
RETURNS TABLE (superseded text, superseded_by text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT DISTINCT f.old_name, f.new_name
  FROM public.function_changes f
  JOIN public.sessions s ON s.id = f.session_id AND s.org_id = f.org_id
  WHERE f.org_id = match_org AND f.session_id = match_session
    AND s.kind = 'conversation'
    AND s.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.project_scope IS NOT DISTINCT FROM match_project_scope
    AND f.source_exchange_id = ANY(exchange_ids)
    AND NOT f.is_suppressed
    AND f.old_name <> '' AND f.new_name IS NOT NULL
    AND f.new_name <> '' AND f.new_name <> f.old_name;
$$;
REVOKE EXECUTE ON FUNCTION public.find_fresh_exchange_function_superseded(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_fresh_exchange_function_superseded(uuid, uuid, text, uuid[]) TO service_role;
