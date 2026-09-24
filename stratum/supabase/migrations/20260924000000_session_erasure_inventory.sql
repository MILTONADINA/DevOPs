-- Read-only local database inventory for a scoped session erasure request.
-- This does not delete data or decide whether billing may legally be retained.
CREATE OR REPLACE FUNCTION public.inspect_session_erasure(p_org_id uuid, p_session_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
WITH target AS (
  SELECT id, org_id FROM public.sessions
  WHERE id = p_session_id AND org_id = p_org_id
), fact_ids AS (
  SELECT 'function_changes'::text AS fact_table, id FROM public.function_changes WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'tech_decisions', id FROM public.tech_decisions WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'policy_updates', id FROM public.policy_updates WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'todos', id FROM public.todos WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'variable_changes', id FROM public.variable_changes WHERE org_id = p_org_id AND session_id = p_session_id
), target_entities AS (
  SELECT id FROM public.knowledge_entities WHERE org_id = p_org_id AND session_id = p_session_id
)
SELECT jsonb_build_object(
  'scope', 'local_database_only',
  'org_id', target.org_id,
  'session_id', target.id,
  'counts', jsonb_build_object(
    'sessions', 1,
    'billing_records', (SELECT count(*) FROM public.billing_records WHERE org_id = p_org_id AND session_id = p_session_id),
    'pruning_logs', (SELECT count(*) FROM public.pruning_logs WHERE session_id = p_session_id),
    'function_changes', (SELECT count(*) FROM public.function_changes WHERE org_id = p_org_id AND session_id = p_session_id),
    'tech_decisions', (SELECT count(*) FROM public.tech_decisions WHERE org_id = p_org_id AND session_id = p_session_id),
    'policy_updates', (SELECT count(*) FROM public.policy_updates WHERE org_id = p_org_id AND session_id = p_session_id),
    'todos', (SELECT count(*) FROM public.todos WHERE org_id = p_org_id AND session_id = p_session_id),
    'variable_changes', (SELECT count(*) FROM public.variable_changes WHERE org_id = p_org_id AND session_id = p_session_id),
    'audit_conflicts', (SELECT count(*) FROM public.audit_conflicts
      WHERE org_id = p_org_id AND (session_id = p_session_id OR (fact_table, fact_id) IN (SELECT fact_table, id FROM fact_ids))),
    'audit_statuses', (SELECT count(*) FROM public.audit_statuses
      WHERE org_id = p_org_id AND (fact_table, fact_id) IN (SELECT fact_table, id FROM fact_ids)),
    'knowledge_entities', (SELECT count(*) FROM target_entities),
    'knowledge_edges', (SELECT count(*) FROM public.knowledge_edges
      WHERE org_id = p_org_id AND (session_id = p_session_id
        OR from_entity IN (SELECT id FROM target_entities) OR to_entity IN (SELECT id FROM target_entities))),
    'source_fact_links', (SELECT count(*) FROM public.source_fact_links
      WHERE org_id = p_org_id AND (file_entity_id IN (SELECT id FROM target_entities)
        OR function_change_id IN (SELECT id FROM fact_ids WHERE fact_table = 'function_changes')
        OR tech_decision_id IN (SELECT id FROM fact_ids WHERE fact_table = 'tech_decisions'))),
    'memory_vectors', (SELECT count(*) FROM public.memory_vectors
      WHERE org_id = p_org_id AND (session_id = p_session_id
        OR (source_type = 'fact' AND source_ref IN (SELECT id::text FROM fact_ids))
        OR (source_type = 'entity' AND source_ref IN (SELECT id::text FROM target_entities))))
  ),
  -- Session IDs are optional on graph rows, and ensureEntity reuses nodes.
  -- No count here can prove exclusive ownership; erasure must fail closed.
  'graph_ownership', 'ambiguous',
  'org_only_classes', jsonb_build_array('invoices', 'api_keys', 'developers', 'org_config', 'organizations'),
  'external_copies', 'not_inventoried',
  'backups', 'not_inventoried',
  'in_memory', 'not_inventoried'
) FROM target;
$$;

REVOKE EXECUTE ON FUNCTION public.inspect_session_erasure(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_session_erasure(uuid, uuid) TO service_role;
