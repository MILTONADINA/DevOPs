-- Derive audit-read project scope from the referenced typed fact, rather than
-- trusting the audit row's session or a client-supplied project identifier.
CREATE FUNCTION public.project_audit_fact_refs(match_org uuid, match_project_scope text)
RETURNS TABLE (fact_table text, fact_id uuid)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT 'function_changes'::text, id FROM public.function_changes
    WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope
  UNION ALL
  SELECT 'tech_decisions'::text, id FROM public.tech_decisions
    WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope
  UNION ALL
  SELECT 'policy_updates'::text, id FROM public.policy_updates
    WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope
  UNION ALL
  SELECT 'todos'::text, id FROM public.todos
    WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope
  UNION ALL
  SELECT 'variable_changes'::text, id FROM public.variable_changes
    WHERE org_id = match_org AND project_scope IS NOT DISTINCT FROM match_project_scope;
$$;

CREATE FUNCTION public.list_project_audit_conflicts(
  match_org uuid, match_project_scope text, result_limit integer
)
RETURNS TABLE (
  id uuid, detected_at timestamptz, fact_table text, fact_id uuid,
  claimed_state text, actual_state text, conflict_commit text, acknowledged boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.detected_at, c.fact_table, c.fact_id, c.claimed_state,
         c.actual_state, c.conflict_commit, c.acknowledged
  FROM public.audit_conflicts c
  JOIN public.project_audit_fact_refs(match_org, match_project_scope) f
    ON f.fact_table = c.fact_table AND f.fact_id = c.fact_id
  WHERE c.org_id = match_org AND NOT c.acknowledged
  ORDER BY c.detected_at DESC, c.id DESC
  LIMIT GREATEST(0, LEAST(result_limit, 500));
$$;

CREATE FUNCTION public.list_project_audit_statuses(
  match_org uuid, match_project_scope text, result_limit integer
)
RETURNS TABLE (
  fact_table text, fact_id uuid, status text, audited_at timestamptz,
  evidence_commit text, detail text
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT s.fact_table, s.fact_id, s.status, s.audited_at,
         s.evidence_commit, s.detail
  FROM public.audit_statuses s
  JOIN public.project_audit_fact_refs(match_org, match_project_scope) f
    ON f.fact_table = s.fact_table AND f.fact_id = s.fact_id
  WHERE s.org_id = match_org
  ORDER BY s.audited_at DESC, s.fact_id DESC
  LIMIT GREATEST(0, LEAST(result_limit, 500));
$$;

REVOKE EXECUTE ON FUNCTION public.project_audit_fact_refs(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_project_audit_conflicts(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_project_audit_statuses(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_audit_fact_refs(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_project_audit_conflicts(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_project_audit_statuses(uuid, text, integer) TO service_role;
