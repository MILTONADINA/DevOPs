-- specs/memory/session-erasure.md REQ-5/9, AC-B1/B4.
-- Bind privileged activation to an operator-verified artifact. This migration
-- does not activate a deployment or upgrade any existing organization/session.
-- The migration runner supplies the transaction; applied200..500 stay unchanged.

ALTER TABLE public.erasure_deployment ADD COLUMN source_manifest_sha256 text;

-- No prior execution has an artifact digest. Disable, never invent a backfill.
-- Existing uncertainty, enrollment, fences, receipts and tombstones are untouched.
UPDATE public.erasure_deployment SET enabled=false WHERE enabled;
ALTER TABLE public.erasure_deployment
  ADD CONSTRAINT erasure_deployment_source_manifest_format CHECK (
    source_manifest_sha256 IS NULL OR
    (length(source_manifest_sha256)=64 AND source_manifest_sha256 ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT erasure_deployment_bound_generation CHECK (
    NOT enabled OR source_manifest_sha256 IS NOT NULL);

-- Existing table SELECT covers this metadata column; no new write grants, roles
-- or setter RPCs. CREATE OR REPLACE preserves the private planner owner and ACL.
-- Its500 body changes only the deployment binding predicate and honest reasons.
CREATE OR REPLACE FUNCTION public.build_session_erasure_plan(p_org_id uuid,p_session_id uuid)
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
  SELECT COALESCE(bool_or(enabled AND source_generation='managed_explicit_session_v1' AND activation_id IS NOT NULL
      AND source_manifest_sha256 IS NOT NULL AND length(source_manifest_sha256)=64
      AND source_manifest_sha256 ~ '^[a-f0-9]{64}$'),false)
    INTO deployment_ok FROM public.erasure_deployment WHERE id;
  SELECT EXISTS(SELECT 1 FROM public.erasure_org_coverage c JOIN public.erasure_deployment d
    ON d.id AND c.activation_id=d.activation_id WHERE c.org_id=p_org_id AND c.unknown_at IS NULL) INTO coverage_ok;
  SELECT EXISTS(SELECT 1 FROM public.session_erasure_state s JOIN public.erasure_deployment d
    ON d.id AND s.activation_id=d.activation_id WHERE s.org_id=p_org_id AND s.session_id=p_session_id AND s.state IN('active','erasing')) INTO enrollment_ok;
  IF NOT deployment_ok THEN reasons:=array_append(reasons,'deployment_unverified'); END IF;
  IF NOT coverage_ok THEN reasons:=array_append(reasons,'coverage_unknown'); END IF;
  IF NOT enrollment_ok THEN reasons:=array_append(reasons,'session_not_enrolled'); END IF;
  IF NOT (deployment_ok AND coverage_ok AND enrollment_ok) THEN
    reasons:=array_append(reasons,'stores_not_inventoried');
  END IF;
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

