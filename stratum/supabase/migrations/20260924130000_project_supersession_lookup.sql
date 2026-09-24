-- Commercial shadow pruning may consult only verified, session-attributed
-- supersession relations in the exact authenticated project.
CREATE FUNCTION public.find_project_superseded(match_org uuid, match_project_scope text, names text[])
RETURNS TABLE (superseded text, superseded_by text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT stale.name, current.name
  FROM public.knowledge_edges edge
  JOIN public.knowledge_entities current ON current.id = edge.from_entity AND current.org_id = match_org
  JOIN public.knowledge_entities stale ON stale.id = edge.to_entity AND stale.org_id = match_org
  WHERE edge.org_id = match_org AND edge.edge_type = 'SUPERSEDES'
    AND edge.scope_verified AND current.scope_verified AND stale.scope_verified
    AND edge.provenance_complete AND current.provenance_complete AND stale.provenance_complete
    AND edge.project_scope IS NOT DISTINCT FROM match_project_scope
    AND current.project_scope IS NOT DISTINCT FROM match_project_scope
    AND stale.project_scope IS NOT DISTINCT FROM match_project_scope
    AND stale.name = ANY(names);
$$;
REVOKE EXECUTE ON FUNCTION public.find_project_superseded(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_project_superseded(uuid, text, text[]) TO service_role;
