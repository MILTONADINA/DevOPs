-- Track every trusted session that uses a graph row. Older graph rows remain
-- provenance-incomplete even after their first known session is backfilled.
ALTER TABLE public.knowledge_entities ADD COLUMN provenance_complete boolean NOT NULL DEFAULT false;
ALTER TABLE public.knowledge_edges ADD COLUMN provenance_complete boolean NOT NULL DEFAULT false;
ALTER TABLE public.knowledge_entities ADD CONSTRAINT knowledge_entities_complete_has_session
  CHECK (NOT provenance_complete OR session_id IS NOT NULL);
ALTER TABLE public.knowledge_edges ADD CONSTRAINT knowledge_edges_complete_has_session
  CHECK (NOT provenance_complete OR session_id IS NOT NULL);
ALTER TABLE public.knowledge_edges ADD CONSTRAINT knowledge_edges_org_id_id_key UNIQUE (org_id, id);

CREATE TABLE public.knowledge_entity_sessions (
  org_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  session_id uuid NOT NULL,
  PRIMARY KEY (org_id, entity_id, session_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES public.knowledge_entities(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, session_id) REFERENCES public.sessions(org_id, id)
);
CREATE INDEX knowledge_entity_sessions_session_idx ON public.knowledge_entity_sessions(org_id, session_id);

CREATE TABLE public.knowledge_edge_sessions (
  org_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  session_id uuid NOT NULL,
  PRIMARY KEY (org_id, edge_id, session_id),
  FOREIGN KEY (org_id, edge_id) REFERENCES public.knowledge_edges(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, session_id) REFERENCES public.sessions(org_id, id)
);
CREATE INDEX knowledge_edge_sessions_session_idx ON public.knowledge_edge_sessions(org_id, session_id);

ALTER TABLE public.knowledge_entity_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_edge_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.knowledge_entity_sessions, public.knowledge_edge_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.knowledge_entity_sessions, public.knowledge_edge_sessions TO service_role;

-- Direct inserts with a session ID get their first link in the same transaction.
CREATE FUNCTION public.record_graph_session_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.session_id IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'knowledge_entities' THEN
    INSERT INTO public.knowledge_entity_sessions(org_id, entity_id, session_id)
      VALUES (NEW.org_id, NEW.id, NEW.session_id) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.knowledge_edge_sessions(org_id, edge_id, session_id)
      VALUES (NEW.org_id, NEW.id, NEW.session_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_graph_entity_session_provenance
  AFTER INSERT OR UPDATE OF session_id ON public.knowledge_entities
  FOR EACH ROW EXECUTE FUNCTION public.record_graph_session_provenance();
CREATE TRIGGER trg_graph_edge_session_provenance
  AFTER INSERT OR UPDATE OF session_id ON public.knowledge_edges
  FOR EACH ROW EXECUTE FUNCTION public.record_graph_session_provenance();

INSERT INTO public.knowledge_entity_sessions(org_id, entity_id, session_id)
  SELECT org_id, id, session_id FROM public.knowledge_entities WHERE session_id IS NOT NULL
  ON CONFLICT DO NOTHING;
INSERT INTO public.knowledge_edge_sessions(org_id, edge_id, session_id)
  SELECT org_id, id, session_id FROM public.knowledge_edges WHERE session_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- The previous inventory remains service-only. Replace it to include rows used
-- through provenance links, while keeping untagged/legacy graph rows unresolved.
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
