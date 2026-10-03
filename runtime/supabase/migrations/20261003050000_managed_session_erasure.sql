-- specs/memory/session-erasure.md REQ-1/2/3/10/11/12/15/16.
-- Default-disabled managed explicit erasure; no operator activation here.

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
        OR (source_type = 'fact' AND public.erasure_source_uuid(source_ref) IN (SELECT id FROM fact_ids))
        OR (source_type = 'entity' AND public.erasure_source_uuid(source_ref) IN (SELECT id FROM target_entities))))
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
  'org_only_classes', jsonb_build_array('api_keys', 'developers', 'org_config', 'organizations'),
  'retained_metadata_classes', jsonb_build_array('erasure_deployment', 'erasure_org_coverage', 'session_erasure_state'),
  'external_copies', 'not_inventoried', 'backups', 'not_inventoried', 'in_memory', 'not_inventoried'
) FROM target;
$$;

-- Only private authority functions may obtain this identity plan. Public outputs
-- are fixed counts/reasons/receipts, never these captured IDs or protected content.
CREATE FUNCTION public.build_session_erasure_plan(p_org_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
  reasons text[] := '{}'; fact_tables constant text[] := ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'];
  t text; ids uuid[]; facts jsonb := '{}'; fact_ids uuid[] := '{}';
  all_entities uuid[]; private_entities uuid[]; kept_entities uuid[];
  all_edges uuid[]; private_edges uuid[]; kept_edges uuid[];
  audit_ids uuid[]; audit_keys jsonb; vectors uuid[]; kept_vectors uuid[];
  links uuid[]; kept_links uuid[]; pruning uuid[]; usage_ids uuid[];
  r record; owner_count bigint; source_org uuid; source_session uuid;
  deployment_ok boolean; coverage_ok boolean; enrollment_ok boolean;
  classified text[] := ARRAY['api_keys','audit_conflicts','audit_statuses','billing_records','developers','erasure_deployment','erasure_org_coverage','function_changes','knowledge_edge_sessions','knowledge_edges','knowledge_entities','knowledge_entity_sessions','memory_vectors','operational_references','org_config','organizations','policy_updates','pruning_logs','session_erasure_state','sessions','source_fact_links','tech_decisions','todos','variable_changes'];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE org_id=p_org_id AND id=p_session_id AND kind='explicit') THEN RETURN NULL; END IF;
  SELECT COALESCE(bool_or(enabled AND source_generation='managed_explicit_session_v1' AND activation_id IS NOT NULL),false)
    INTO deployment_ok FROM public.erasure_deployment WHERE id;
  SELECT EXISTS(SELECT 1 FROM public.erasure_org_coverage c JOIN public.erasure_deployment d
    ON d.id AND c.activation_id=d.activation_id WHERE c.org_id=p_org_id AND c.unknown_at IS NULL) INTO coverage_ok;
  SELECT EXISTS(SELECT 1 FROM public.session_erasure_state s JOIN public.erasure_deployment d
    ON d.id AND s.activation_id=d.activation_id WHERE s.org_id=p_org_id AND s.session_id=p_session_id AND s.state IN('active','erasing')) INTO enrollment_ok;
  IF NOT deployment_ok THEN reasons:=array_append(reasons,'deployment_unverified'); END IF;
  IF NOT coverage_ok THEN reasons:=array_append(reasons,'coverage_unknown'); END IF;
  IF NOT enrollment_ok THEN reasons:=array_append(reasons,'session_not_enrolled'); END IF;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN('r','p','f','m')) IS DISTINCT FROM classified THEN
    reasons:=array_append(reasons,'unknown_database_class');
  END IF;

  FOREACH t IN ARRAY fact_tables LOOP
    EXECUTE format('SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) FROM public.%I WHERE org_id=$1 AND session_id=$2',t)
      INTO ids USING p_org_id,p_session_id;
    facts:=facts||jsonb_build_object(t,ids); fact_ids:=fact_ids||ids;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO fact_ids FROM unnest(fact_ids) id;
  -- A generic UUID must not retire an unrelated retained fact in another table/org.
  FOREACH t IN ARRAY fact_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=ANY($1) AND (org_id<>$2 OR session_id<>$3)',t)
      INTO owner_count USING fact_ids,p_org_id,p_session_id;
    IF owner_count<>0 THEN reasons:=array_append(reasons,'ownership_inconsistent'); END IF;
  END LOOP;
  IF cardinality(fact_ids)<>(SELECT count(DISTINCT id) FROM unnest(fact_ids) id) THEN
    reasons:=array_append(reasons,'ownership_inconsistent');
  END IF;

  SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO all_entities FROM public.knowledge_entities e
    WHERE e.org_id=p_org_id AND (e.session_id=p_session_id OR EXISTS(SELECT 1 FROM public.knowledge_entity_sessions s
      WHERE s.org_id=p_org_id AND s.entity_id=e.id AND s.session_id=p_session_id));
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO private_entities FROM public.knowledge_entities e
    WHERE e.id=ANY(all_entities) AND e.session_id=p_session_id AND NOT EXISTS(SELECT 1 FROM public.knowledge_entity_sessions s
      WHERE s.entity_id=e.id AND s.session_id<>p_session_id);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO kept_entities FROM unnest(all_entities) id WHERE NOT id=ANY(private_entities);
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO all_edges FROM public.knowledge_edges e
    WHERE e.org_id=p_org_id AND (e.session_id=p_session_id OR EXISTS(SELECT 1 FROM public.knowledge_edge_sessions s
      WHERE s.org_id=p_org_id AND s.edge_id=e.id AND s.session_id=p_session_id)
      OR e.from_entity=ANY(all_entities) OR e.to_entity=ANY(all_entities));
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),'{}') INTO private_edges FROM public.knowledge_edges e
    WHERE e.id=ANY(all_edges) AND e.session_id=p_session_id AND NOT EXISTS(SELECT 1 FROM public.knowledge_edge_sessions s
      WHERE s.edge_id=e.id AND s.session_id<>p_session_id);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO kept_edges FROM unnest(all_edges) id WHERE NOT id=ANY(private_edges);

  IF EXISTS(SELECT 1 FROM public.knowledge_entities WHERE id=ANY(all_entities) AND NOT provenance_complete)
    OR EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=ANY(all_edges) AND NOT provenance_complete) THEN
    reasons:=array_append(reasons,'graph_ownership_ambiguous');
  END IF;
  IF EXISTS(SELECT 1 FROM public.knowledge_entities WHERE id=ANY(kept_entities) AND session_id=p_session_id)
    OR EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=ANY(kept_edges) AND session_id=p_session_id) THEN
    reasons:=array_append(reasons,'shared_origin_unsupported');
  END IF;
  IF EXISTS(SELECT 1 FROM public.knowledge_entities e WHERE e.id=ANY(all_entities) AND
      (NOT EXISTS(SELECT 1 FROM public.knowledge_entity_sessions s WHERE s.org_id=e.org_id AND s.entity_id=e.id AND s.session_id=e.session_id)
       OR NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=e.session_id AND s.org_id=e.org_id AND s.kind='explicit' AND s.project_scope IS NOT DISTINCT FROM e.project_scope)))
    OR EXISTS(SELECT 1 FROM public.knowledge_edges e WHERE e.id=ANY(all_edges) AND
      (NOT EXISTS(SELECT 1 FROM public.knowledge_edge_sessions s WHERE s.org_id=e.org_id AND s.edge_id=e.id AND s.session_id=e.session_id)
       OR NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=e.session_id AND s.org_id=e.org_id AND s.kind='explicit' AND s.project_scope IS NOT DISTINCT FROM e.project_scope)))
    OR EXISTS(SELECT 1 FROM public.knowledge_entity_sessions l LEFT JOIN public.sessions s ON s.id=l.session_id AND s.org_id=l.org_id
      WHERE l.entity_id=ANY(all_entities) AND (l.org_id<>p_org_id OR s.id IS NULL OR s.kind<>'explicit'))
    OR EXISTS(SELECT 1 FROM public.knowledge_edge_sessions l LEFT JOIN public.sessions s ON s.id=l.session_id AND s.org_id=l.org_id
      WHERE l.edge_id=ANY(all_edges) AND (l.org_id<>p_org_id OR s.id IS NULL OR s.kind<>'explicit')) THEN
    reasons:=array_append(reasons,'ownership_inconsistent');
  END IF;
  IF EXISTS(SELECT 1 FROM public.knowledge_edges e WHERE (e.from_entity=ANY(private_entities) OR e.to_entity=ANY(private_entities)) AND NOT e.id=ANY(private_edges))
    OR EXISTS(SELECT 1 FROM public.source_fact_links l WHERE l.file_entity_id=ANY(private_entities)
      AND NOT(COALESCE(l.function_change_id=ANY(fact_ids),false) OR COALESCE(l.tech_decision_id=ANY(fact_ids),false)))
    OR EXISTS(SELECT 1 FROM public.tech_decisions d WHERE d.supersedes_id=ANY(fact_ids) AND (d.org_id<>p_org_id OR d.session_id<>p_session_id)) THEN
    reasons:=array_append(reasons,'incoming_reference_unsupported');
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO pruning FROM public.pruning_logs WHERE session_id=p_session_id;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO usage_ids FROM public.billing_records WHERE org_id=p_org_id AND session_id=p_session_id;
  IF EXISTS(SELECT 1 FROM public.billing_records WHERE pruning_log_id=ANY(pruning) AND (org_id<>p_org_id OR session_id<>p_session_id)) THEN
    reasons:=array_append(reasons,'incoming_reference_unsupported');
  END IF;
  IF EXISTS(SELECT 1 FROM public.billing_records b LEFT JOIN public.pruning_logs l ON l.id=b.pruning_log_id
    WHERE b.id=ANY(usage_ids) AND b.pruning_log_id IS NOT NULL AND (l.id IS NULL OR l.session_id<>p_session_id)) THEN
    reasons:=array_append(reasons,'ownership_inconsistent');
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO audit_ids FROM public.audit_conflicts
    WHERE org_id=p_org_id AND (session_id=p_session_id OR fact_id=ANY(fact_ids));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fact_table',fact_table,'fact_id',fact_id) ORDER BY fact_table,fact_id),'[]') INTO audit_keys
    FROM public.audit_statuses WHERE org_id=p_org_id AND fact_id=ANY(fact_ids);
  FOR r IN SELECT org_id,fact_table,fact_id FROM public.audit_conflicts WHERE session_id=p_session_id OR fact_id=ANY(fact_ids)
      UNION ALL SELECT org_id,fact_table,fact_id FROM public.audit_statuses WHERE fact_id=ANY(fact_ids) LOOP
    IF r.org_id<>p_org_id OR NOT r.fact_table=ANY(fact_tables) THEN reasons:=array_append(reasons,'ownership_inconsistent'); CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=$1 AND org_id=$2',r.fact_table)
      INTO owner_count USING r.fact_id,p_org_id;
    IF owner_count<>1 THEN reasons:=array_append(reasons,'generic_reference_unresolved'); END IF;
  END LOOP;

  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO links FROM public.source_fact_links WHERE org_id=p_org_id AND
    (file_entity_id=ANY(private_entities) OR function_change_id=ANY(fact_ids) OR tech_decision_id=ANY(fact_ids));
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO kept_links FROM public.source_fact_links WHERE org_id=p_org_id AND file_entity_id=ANY(kept_entities) AND NOT id=ANY(links);
  IF EXISTS(SELECT 1 FROM public.source_fact_links WHERE org_id<>p_org_id AND
    (file_entity_id=ANY(all_entities) OR function_change_id=ANY(fact_ids) OR tech_decision_id=ANY(fact_ids))) THEN
    reasons:=array_append(reasons,'ownership_inconsistent');
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO vectors FROM public.memory_vectors WHERE org_id=p_org_id AND
    (session_id=p_session_id OR (source_type='fact' AND public.erasure_source_uuid(source_ref)=ANY(fact_ids))
     OR (source_type='entity' AND public.erasure_source_uuid(source_ref)=ANY(private_entities)));
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO kept_vectors FROM public.memory_vectors WHERE org_id=p_org_id
    AND source_type='entity' AND public.erasure_source_uuid(source_ref)=ANY(kept_entities) AND NOT id=ANY(vectors);
  FOR r IN SELECT * FROM public.memory_vectors WHERE session_id=p_session_id
      OR (source_type='fact' AND public.erasure_source_uuid(source_ref)=ANY(fact_ids))
      OR (source_type='entity' AND public.erasure_source_uuid(source_ref)=ANY(all_entities)) LOOP
    IF r.org_id<>p_org_id OR (r.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=r.session_id AND org_id=p_org_id)) THEN
      reasons:=array_append(reasons,'ownership_inconsistent'); CONTINUE;
    END IF;
    IF r.source_type='fact' THEN
      owner_count:=0;
      FOREACH t IN ARRAY fact_tables LOOP
        EXECUTE format('SELECT org_id,session_id FROM public.%I WHERE id=$1',t) INTO source_org,source_session USING public.erasure_source_uuid(r.source_ref);
        IF source_org IS NOT NULL THEN
          owner_count:=owner_count+1;
          IF source_org<>p_org_id THEN reasons:=array_append(reasons,'ownership_inconsistent'); END IF;
          IF r.session_id=p_session_id AND source_session<>p_session_id THEN reasons:=array_append(reasons,'incoming_reference_unsupported'); END IF;
        END IF;
      END LOOP;
      IF owner_count<>1 THEN reasons:=array_append(reasons,'generic_reference_unresolved'); END IF;
    ELSIF r.source_type='entity' THEN
      SELECT org_id,session_id INTO source_org,source_session FROM public.knowledge_entities WHERE id=public.erasure_source_uuid(r.source_ref);
      IF source_org IS NULL THEN reasons:=array_append(reasons,'generic_reference_unresolved');
      ELSIF source_org<>p_org_id THEN reasons:=array_append(reasons,'ownership_inconsistent');
      ELSIF r.session_id=p_session_id AND NOT public.erasure_source_uuid(r.source_ref)=ANY(private_entities) THEN reasons:=array_append(reasons,'incoming_reference_unsupported'); END IF;
    ELSE
      -- Explicit turns have no trustworthy content/owner path in this generation.
      reasons:=array_append(reasons,'generic_reference_unresolved');
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT reason ORDER BY reason),'{}') INTO reasons FROM unnest(reasons) reason;
  RETURN jsonb_build_object('reasons',reasons,'deployment_ok',deployment_ok,'coverage_ok',coverage_ok,'enrollment_ok',enrollment_ok,
    'facts',facts,'fact_ids',fact_ids,'all_entities',all_entities,'private_entities',private_entities,'kept_entities',kept_entities,
    'all_edges',all_edges,'private_edges',private_edges,'kept_edges',kept_edges,
    'audit_ids',audit_ids,'audit_keys',audit_keys,'vectors',vectors,'kept_vectors',kept_vectors,'links',links,'kept_links',kept_links,
    'pruning',pruning,'usage_ids',usage_ids,
    'retained',jsonb_build_object('knowledge_entities',cardinality(kept_entities),'knowledge_edges',cardinality(kept_edges),
      'knowledge_entity_sessions',(SELECT count(*) FROM public.knowledge_entity_sessions WHERE entity_id=ANY(kept_entities) AND session_id<>p_session_id),
      'knowledge_edge_sessions',(SELECT count(*) FROM public.knowledge_edge_sessions WHERE edge_id=ANY(kept_edges) AND session_id<>p_session_id),
      'source_fact_links',cardinality(kept_links),'memory_vectors',cardinality(kept_vectors),
      'erasure_deployment',1,'erasure_org_coverage',1,'session_erasure_state',1,'erased_fact_ids',cardinality(fact_ids),'erased_entity_ids',cardinality(private_entities)));
END;
$$;

CREATE FUNCTION public.inspect_managed_session_erasure(p_org_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE plan jsonb; ready boolean; managed boolean;
BEGIN
  plan:=public.build_session_erasure_plan(p_org_id,p_session_id);
  IF plan IS NULL THEN RETURN NULL; END IF;
  ready:=jsonb_array_length(plan->'reasons')=0;
  managed:=(plan->>'deployment_ok')::boolean AND (plan->>'coverage_ok')::boolean AND (plan->>'enrollment_ok')::boolean;
  RETURN jsonb_build_object('status',CASE WHEN ready THEN 'ready' ELSE 'blocked' END,'reasons',plan->'reasons',
    'inventory',public.inspect_session_erasure(p_org_id,p_session_id),
    'classifications',jsonb_build_object('scope','managed_explicit_session_v1',
      'deployment',CASE WHEN (plan->>'deployment_ok')::boolean THEN 'covered' ELSE 'unknown' END,
      'enrollment',CASE WHEN managed THEN 'covered' ELSE 'unknown' END,
      'database',CASE WHEN ready THEN 'covered' ELSE 'unknown' END,
      'in_memory',CASE WHEN managed THEN 'excluded' ELSE 'unknown' END,
      'external_copies',CASE WHEN managed THEN 'excluded' ELSE 'unknown' END,
      'backups',CASE WHEN managed THEN 'excluded' ELSE 'unknown' END));
END;
$$;

-- Unlike the ordinary writer helper this can lock a deleted org's receipt.
-- It does not create metadata, enroll, authorize deletion or reset uncertainty.
CREATE FUNCTION public.lock_session_erasure_request(p_org_id uuid,p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_org_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='erasure scope required';
  END IF;
  PERFORM id FROM public.erasure_deployment WHERE id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure authority unavailable'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('session_cap:'||p_org_id::text)::bigint);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('erasure_session:'||p_session_id::text)::bigint);
END;
$$;

CREATE FUNCTION public.prepare_session_erasure(p_org_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE plan jsonb; authority public.session_erasure_state%ROWTYPE;
BEGIN
  PERFORM public.lock_session_erasure_request(p_org_id,p_session_id);
  SELECT * INTO authority FROM public.session_erasure_state WHERE org_id=p_org_id AND session_id=p_session_id;
  IF authority.state='complete' THEN RETURN authority.receipt; END IF;
  plan:=public.build_session_erasure_plan(p_org_id,p_session_id);
  IF plan IS NULL THEN RETURN NULL; END IF;
  IF jsonb_array_length(plan->'reasons')<>0 THEN
    RETURN jsonb_build_object('status','blocked','scope','managed_explicit_session_v1','org_id',p_org_id,'session_id',p_session_id,'reasons',plan->'reasons');
  END IF;
  IF authority.state='active' THEN
    UPDATE public.session_erasure_state SET state='erasing',request_id=pg_catalog.gen_random_uuid(),prepared_at=pg_catalog.clock_timestamp()
      WHERE org_id=p_org_id AND session_id=p_session_id AND state='active' RETURNING * INTO authority;
  END IF;
  IF authority.state IS DISTINCT FROM 'erasing' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure enrollment unavailable'; END IF;
  RETURN jsonb_build_object('status','prepared','scope','managed_explicit_session_v1','org_id',p_org_id,'session_id',p_session_id,'request_id',authority.request_id);
END;
$$;

CREATE FUNCTION public.execute_session_erasure(p_org_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  plan jsonb; refreshed jsonb; authority public.session_erasure_state%ROWTYPE;
  fact_ids uuid[]; entity_ids uuid[]; edge_ids uuid[]; all_entities uuid[]; all_edges uuid[];
  ids uuid[]; pending uuid[]; leaves uuid[]; identity uuid; t text; affected bigint;
  deleted jsonb:='{}'; completion_receipt jsonb; completed timestamptz;
  fact_tables constant text[]:=ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'];
BEGIN
  PERFORM public.lock_session_erasure_request(p_org_id,p_session_id);
  SELECT * INTO authority FROM public.session_erasure_state WHERE org_id=p_org_id AND session_id=p_session_id;
  IF authority.state='complete' THEN RETURN authority.receipt; END IF;
  IF authority.state IS DISTINCT FROM 'erasing' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure must be prepared'; END IF;
  plan:=public.build_session_erasure_plan(p_org_id,p_session_id);
  IF plan IS NULL OR jsonb_array_length(plan->'reasons')<>0 THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure eligibility changed';
  END IF;
  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid),'{}') INTO entity_ids FROM jsonb_array_elements_text(plan->'private_entities');
  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid),'{}') INTO fact_ids FROM jsonb_array_elements_text(plan->'fact_ids');
  FOREACH identity IN ARRAY entity_ids LOOP PERFORM public.lock_erasure_source('entity',identity); END LOOP;
  FOREACH identity IN ARRAY fact_ids LOOP PERFORM public.lock_erasure_source('fact',identity); END LOOP;
  -- Separate statement after locks: under RC this sees commits that won a lock.
  refreshed:=public.build_session_erasure_plan(p_org_id,p_session_id);
  IF refreshed IS NULL OR jsonb_array_length(refreshed->'reasons')<>0
    OR refreshed->'fact_ids' IS DISTINCT FROM plan->'fact_ids'
    OR refreshed->'private_entities' IS DISTINCT FROM plan->'private_entities' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure ownership changed';
  END IF;
  plan:=refreshed;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO edge_ids FROM jsonb_array_elements_text(plan->'private_edges');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO all_entities FROM jsonb_array_elements_text(plan->'all_entities');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO all_edges FROM jsonb_array_elements_text(plan->'all_edges');

  DELETE FROM public.audit_statuses a WHERE a.org_id=p_org_id AND EXISTS(
    SELECT 1 FROM jsonb_to_recordset(plan->'audit_keys') AS k(fact_table text,fact_id uuid) WHERE (a.fact_table,a.fact_id)=(k.fact_table,k.fact_id));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('audit_statuses',affected);
  DELETE FROM public.audit_conflicts WHERE org_id=p_org_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'audit_ids'));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('audit_conflicts',affected);
  DELETE FROM public.memory_vectors WHERE org_id=p_org_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'vectors'));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('memory_vectors',affected);
  DELETE FROM public.source_fact_links WHERE org_id=p_org_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'links'));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('source_fact_links',affected);
  DELETE FROM public.knowledge_edge_sessions WHERE org_id=p_org_id AND (edge_id=ANY(edge_ids) OR session_id=p_session_id);
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('knowledge_edge_sessions',affected);
  DELETE FROM public.knowledge_entity_sessions WHERE org_id=p_org_id AND (entity_id=ANY(entity_ids) OR session_id=p_session_id);
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('knowledge_entity_sessions',affected);
  DELETE FROM public.knowledge_edges WHERE org_id=p_org_id AND id=ANY(edge_ids);
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('knowledge_edges',affected);
  -- All exclusive parents' dependencies were classified and explicitly removed.
  IF EXISTS(SELECT 1 FROM public.knowledge_edges WHERE from_entity=ANY(entity_ids) OR to_entity=ANY(entity_ids))
    OR EXISTS(SELECT 1 FROM public.source_fact_links WHERE file_entity_id=ANY(entity_ids))
    OR EXISTS(SELECT 1 FROM public.knowledge_entity_sessions WHERE entity_id=ANY(entity_ids)) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure retained parent dependency';
  END IF;
  DELETE FROM public.knowledge_entities WHERE org_id=p_org_id AND id=ANY(entity_ids);
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('knowledge_entities',affected);

  FOREACH t IN ARRAY fact_tables LOOP
    SELECT COALESCE(array_agg(value::uuid),'{}') INTO ids FROM jsonb_array_elements_text(plan->'facts'->t);
    IF t='tech_decisions' THEN
      pending:=ids; affected:=0;
      WHILE cardinality(pending)>0 LOOP
        SELECT COALESCE(array_agg(id),'{}') INTO leaves FROM public.tech_decisions d
          WHERE d.id=ANY(pending) AND d.org_id=p_org_id AND NOT EXISTS(SELECT 1 FROM public.tech_decisions successor WHERE successor.supersedes_id=d.id);
        IF cardinality(leaves)=0 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure decision dependency did not progress'; END IF;
        DELETE FROM public.tech_decisions WHERE org_id=p_org_id AND id=ANY(leaves);
        GET DIAGNOSTICS affected=ROW_COUNT;
        deleted:=deleted||jsonb_build_object(t,COALESCE((deleted->>t)::bigint,0)+affected);
        SELECT COALESCE(array_agg(id),'{}') INTO pending FROM unnest(pending) id WHERE NOT id=ANY(leaves);
      END LOOP;
      IF NOT deleted ? t THEN deleted:=deleted||jsonb_build_object(t,0); END IF;
    ELSE
      EXECUTE format('DELETE FROM public.%I WHERE org_id=$1 AND id=ANY($2)',t) USING p_org_id,ids;
      GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object(t,affected);
    END IF;
  END LOOP;
  DELETE FROM public.billing_records WHERE org_id=p_org_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'usage_ids'));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('billing_records',affected);
  DELETE FROM public.pruning_logs WHERE session_id=p_session_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'pruning'));
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('pruning_logs',affected);
  DELETE FROM public.sessions WHERE org_id=p_org_id AND id=p_session_id;
  GET DIAGNOSTICS affected=ROW_COUNT; deleted:=deleted||jsonb_build_object('sessions',affected);
  IF affected<>1 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure session deletion incomplete'; END IF;

  -- Assert captured identities, not the post-delete inventory (which is NULL).
  FOREACH t IN ARRAY fact_tables LOOP
    SELECT COALESCE(array_agg(value::uuid),'{}') INTO ids FROM jsonb_array_elements_text(plan->'facts'->t);
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id=ANY($1)',t) INTO affected USING ids;
    IF affected<>0 OR (deleted->>t)::bigint<>cardinality(ids) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure fact deletion incomplete'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.sessions WHERE id=p_session_id)
    OR EXISTS(SELECT 1 FROM public.audit_statuses a WHERE a.org_id=p_org_id AND EXISTS(SELECT 1 FROM jsonb_to_recordset(plan->'audit_keys') AS k(fact_table text,fact_id uuid) WHERE (a.fact_table,a.fact_id)=(k.fact_table,k.fact_id)))
    OR EXISTS(SELECT 1 FROM public.audit_conflicts WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'audit_ids')))
    OR EXISTS(SELECT 1 FROM public.memory_vectors WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'vectors')))
    OR EXISTS(SELECT 1 FROM public.source_fact_links WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'links')))
    OR EXISTS(SELECT 1 FROM public.knowledge_entities WHERE id=ANY(entity_ids))
    OR EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=ANY(edge_ids))
    OR EXISTS(SELECT 1 FROM public.knowledge_entity_sessions WHERE session_id=p_session_id OR entity_id=ANY(entity_ids))
    OR EXISTS(SELECT 1 FROM public.knowledge_edge_sessions WHERE session_id=p_session_id OR edge_id=ANY(edge_ids))
    OR EXISTS(SELECT 1 FROM public.billing_records WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'usage_ids')))
    OR EXISTS(SELECT 1 FROM public.pruning_logs WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'pruning'))) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure derivative deletion incomplete';
  END IF;
  IF (SELECT count(*) FROM public.knowledge_entities WHERE id=ANY(all_entities) AND NOT id=ANY(entity_ids) AND provenance_complete AND session_id<>p_session_id)<>(plan->'retained'->>'knowledge_entities')::bigint
    OR (SELECT count(*) FROM public.knowledge_edges WHERE id=ANY(all_edges) AND NOT id=ANY(edge_ids) AND provenance_complete AND session_id<>p_session_id)<>(plan->'retained'->>'knowledge_edges')::bigint
    OR (SELECT count(*) FROM public.knowledge_entity_sessions WHERE entity_id=ANY(all_entities) AND NOT entity_id=ANY(entity_ids))<>(plan->'retained'->>'knowledge_entity_sessions')::bigint
    OR (SELECT count(*) FROM public.knowledge_edge_sessions WHERE edge_id=ANY(all_edges) AND NOT edge_id=ANY(edge_ids))<>(plan->'retained'->>'knowledge_edge_sessions')::bigint
    OR (SELECT count(*) FROM public.source_fact_links WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'kept_links')))<>(plan->'retained'->>'source_fact_links')::bigint
    OR (SELECT count(*) FROM public.memory_vectors WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(plan->'kept_vectors')))<>(plan->'retained'->>'memory_vectors')::bigint THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure shared survival incomplete';
  END IF;
  completed:=pg_catalog.clock_timestamp();
  completion_receipt:=jsonb_build_object('status','complete','scope','managed_explicit_session_v1','org_id',p_org_id,'session_id',p_session_id,
    'request_id',authority.request_id,'completed_at',completed,'deleted',deleted,'retained',plan->'retained',
    'exclusions',jsonb_build_array('client_held_responses','privileged_host_database_snapshots','physical_heap_os_remnants'));
  UPDATE public.session_erasure_state SET state='complete',completed_at=completed,receipt=completion_receipt,
    erased_fact_ids=fact_ids,erased_entity_ids=entity_ids WHERE org_id=p_org_id AND session_id=p_session_id AND state='erasing';
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure completion recording failed'; END IF;
  RETURN completion_receipt;
END;
$$;

GRANT SELECT,DELETE ON TABLE public.audit_conflicts,public.audit_statuses,public.billing_records,
  public.function_changes,public.knowledge_edge_sessions,public.knowledge_edges,public.knowledge_entities,
  public.knowledge_entity_sessions,public.memory_vectors,public.operational_references,public.policy_updates,
  public.pruning_logs,public.sessions,public.source_fact_links,public.tech_decisions,public.todos,public.variable_changes
  TO devops_erasure_executor;
GRANT UPDATE(state,request_id,prepared_at,completed_at,receipt,erased_fact_ids,erased_entity_ids)
  ON public.session_erasure_state TO devops_erasure_executor;
GRANT EXECUTE ON FUNCTION public.inspect_session_erasure(uuid,uuid) TO devops_erasure_executor;
GRANT USAGE,CREATE ON SCHEMA public TO devops_erasure_executor;
ALTER FUNCTION public.build_session_erasure_plan(uuid,uuid) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.inspect_managed_session_erasure(uuid,uuid) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.lock_session_erasure_request(uuid,uuid) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.prepare_session_erasure(uuid,uuid) OWNER TO devops_erasure_executor;
ALTER FUNCTION public.execute_session_erasure(uuid,uuid) OWNER TO devops_erasure_executor;
REVOKE CREATE ON SCHEMA public FROM devops_erasure_executor;
REVOKE ALL ON FUNCTION public.build_session_erasure_plan(uuid,uuid),public.lock_session_erasure_request(uuid,uuid)
  FROM PUBLIC,anon,authenticated,authenticator,service_role;
REVOKE ALL ON FUNCTION public.inspect_managed_session_erasure(uuid,uuid),public.prepare_session_erasure(uuid,uuid),public.execute_session_erasure(uuid,uuid)
  FROM PUBLIC,anon,authenticated,authenticator;
GRANT EXECUTE ON FUNCTION public.inspect_managed_session_erasure(uuid,uuid),public.prepare_session_erasure(uuid,uuid),public.execute_session_erasure(uuid,uuid)
  TO service_role;
