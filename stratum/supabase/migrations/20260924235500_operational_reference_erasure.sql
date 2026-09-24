-- Inventory reference rows and their audit/vector dependencies for session erasure.
CREATE OR REPLACE FUNCTION public.inspect_session_erasure(p_org_id uuid, p_session_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
WITH target AS (
  SELECT id, org_id FROM public.sessions WHERE id = p_session_id AND org_id = p_org_id
), fact_ids AS (
  SELECT 'function_changes'::text AS fact_table, id FROM public.function_changes WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'tech_decisions', id FROM public.tech_decisions WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'policy_updates', id FROM public.policy_updates WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'todos', id FROM public.todos WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'variable_changes', id FROM public.variable_changes WHERE org_id = p_org_id AND session_id = p_session_id
  UNION ALL SELECT 'operational_references', id FROM public.operational_references WHERE org_id = p_org_id AND session_id = p_session_id
), target_entities AS (
  SELECT e.id, e.session_id, e.provenance_complete FROM public.knowledge_entities e
  WHERE e.org_id = p_org_id AND (e.session_id = p_session_id OR EXISTS (
    SELECT 1 FROM public.knowledge_entity_sessions s
    WHERE s.org_id = p_org_id AND s.entity_id = e.id AND s.session_id = p_session_id))
), target_edges AS (
  SELECT e.id, e.session_id, e.provenance_complete FROM public.knowledge_edges e
  WHERE e.org_id = p_org_id AND (e.session_id = p_session_id OR EXISTS (
    SELECT 1 FROM public.knowledge_edge_sessions s
    WHERE s.org_id = p_org_id AND s.edge_id = e.id AND s.session_id = p_session_id)
    OR e.from_entity IN (SELECT id FROM target_entities)
    OR e.to_entity IN (SELECT id FROM target_entities))
)
SELECT jsonb_build_object(
  'scope', 'local_database_only', 'org_id', target.org_id, 'session_id', target.id,
  'counts', jsonb_build_object(
    'sessions', 1,
    'billing_records', (SELECT count(*) FROM public.billing_records WHERE org_id = p_org_id AND session_id = p_session_id),
    'pruning_logs', (SELECT count(*) FROM public.pruning_logs WHERE session_id = p_session_id),
    'function_changes', (SELECT count(*) FROM public.function_changes WHERE org_id = p_org_id AND session_id = p_session_id),
    'tech_decisions', (SELECT count(*) FROM public.tech_decisions WHERE org_id = p_org_id AND session_id = p_session_id),
    'policy_updates', (SELECT count(*) FROM public.policy_updates WHERE org_id = p_org_id AND session_id = p_session_id),
    'todos', (SELECT count(*) FROM public.todos WHERE org_id = p_org_id AND session_id = p_session_id),
    'variable_changes', (SELECT count(*) FROM public.variable_changes WHERE org_id = p_org_id AND session_id = p_session_id),
    'operational_references', (SELECT count(*) FROM public.operational_references WHERE org_id = p_org_id AND session_id = p_session_id),
    'audit_conflicts', (SELECT count(*) FROM public.audit_conflicts
      WHERE org_id = p_org_id AND (session_id = p_session_id OR (fact_table, fact_id) IN (SELECT fact_table, id FROM fact_ids))),
    'audit_statuses', (SELECT count(*) FROM public.audit_statuses
      WHERE org_id = p_org_id AND (fact_table, fact_id) IN (SELECT fact_table, id FROM fact_ids)),
    'knowledge_entities', (SELECT count(*) FROM target_entities),
    'knowledge_edges', (SELECT count(*) FROM target_edges),
    'knowledge_entity_sessions', (SELECT count(*) FROM public.knowledge_entity_sessions
      WHERE org_id = p_org_id AND session_id = p_session_id),
    'knowledge_edge_sessions', (SELECT count(*) FROM public.knowledge_edge_sessions
      WHERE org_id = p_org_id AND session_id = p_session_id),
    'source_fact_links', (SELECT count(*) FROM public.source_fact_links
      WHERE org_id = p_org_id AND (file_entity_id IN (SELECT id FROM target_entities)
        OR function_change_id IN (SELECT id FROM fact_ids WHERE fact_table = 'function_changes')
        OR tech_decision_id IN (SELECT id FROM fact_ids WHERE fact_table = 'tech_decisions'))),
    'memory_vectors', (SELECT count(*) FROM public.memory_vectors
      WHERE org_id = p_org_id AND (session_id = p_session_id
        OR (source_type = 'fact' AND source_ref IN (SELECT id::text FROM fact_ids))
        OR (source_type = 'entity' AND source_ref IN (SELECT id::text FROM target_entities))))
  ),
  'graph_ownership', CASE
    WHEN EXISTS (SELECT 1 FROM target_entities WHERE NOT provenance_complete)
      OR EXISTS (SELECT 1 FROM target_edges WHERE NOT provenance_complete) THEN 'ambiguous'
    WHEN EXISTS (SELECT 1 FROM target_entities e WHERE e.session_id IS DISTINCT FROM p_session_id)
      OR EXISTS (SELECT 1 FROM target_edges e WHERE e.session_id IS DISTINCT FROM p_session_id)
      OR EXISTS (SELECT 1 FROM public.knowledge_entity_sessions s
        WHERE s.org_id = p_org_id AND s.entity_id IN (SELECT id FROM target_entities)
          AND s.session_id <> p_session_id)
      OR EXISTS (SELECT 1 FROM public.knowledge_edge_sessions s
        WHERE s.org_id = p_org_id AND s.edge_id IN (SELECT id FROM target_edges)
          AND s.session_id <> p_session_id) THEN 'shared'
    WHEN EXISTS (SELECT 1 FROM target_entities) OR EXISTS (SELECT 1 FROM target_edges) THEN 'exclusive'
    ELSE 'none'
  END,
  'unattributed_graph', 'not_inventoried',
  'org_only_classes', jsonb_build_array('invoices', 'api_keys', 'developers', 'org_config', 'organizations'),
  'external_copies', 'not_inventoried', 'backups', 'not_inventoried', 'in_memory', 'not_inventoried'
) FROM target;
$$;
