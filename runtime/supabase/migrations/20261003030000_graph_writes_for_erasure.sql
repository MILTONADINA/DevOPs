-- specs/memory/session-erasure.md REQ-1a/8/11, AC-B3/B8/B13.
-- Covered graph reuse stays inside the transaction and returns only an ID.
-- Invoker authority deliberately preserves ordinary content/source-link guards.
CREATE FUNCTION public.write_managed_graph_entity(p_org_id uuid, p_session_id uuid, p_input jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE row_id uuid; row_complete boolean; session_project text; target_state text;
BEGIN
  PERFORM public.lock_erasure_org(p_org_id);
  SELECT state INTO target_state FROM public.session_erasure_state
    WHERE org_id = p_org_id AND session_id = p_session_id;
  IF target_state IN ('erasing','complete') THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='managed graph session is fenced';
  END IF;
  -- These are authority/session metadata reads only. NULL never follows a
  -- protected graph read and is the sole permission to use the marked legacy path.
  IF NOT EXISTS (
    SELECT 1 FROM public.erasure_org_coverage c
    JOIN public.erasure_deployment d ON d.id AND d.enabled
      AND d.source_generation='managed_explicit_session_v1' AND c.activation_id=d.activation_id
    JOIN public.session_erasure_state e ON e.org_id=c.org_id AND e.session_id=p_session_id
      AND e.state='active' AND e.activation_id=d.activation_id
    WHERE c.org_id=p_org_id AND c.unknown_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT project_scope INTO session_project FROM public.sessions
    WHERE org_id=p_org_id AND id=p_session_id AND kind='explicit';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (p_input - ARRAY['kind','name','project_scope','scope_verified','file_path','summary']) <> '{}'::jsonb
    OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string'
    OR NOT (p_input ? 'project_scope')
    OR jsonb_typeof(p_input->'project_scope') NOT IN ('string','null')
    OR jsonb_typeof(p_input->'scope_verified') IS DISTINCT FROM 'boolean'
    OR (p_input ? 'file_path' AND jsonb_typeof(p_input->'file_path') IS DISTINCT FROM 'string')
    OR (p_input ? 'summary' AND jsonb_typeof(p_input->'summary') IS DISTINCT FROM 'string')
    OR (p_input->>'project_scope') IS DISTINCT FROM session_project THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid managed graph input';
  END IF;
  IF p_input->'scope_verified' <> 'true'::jsonb THEN RETURN NULL; END IF;

  SELECT id, provenance_complete INTO row_id, row_complete FROM public.knowledge_entities
    WHERE org_id=p_org_id AND kind=p_input->>'kind' AND name=p_input->>'name'
      AND scope_verified AND project_scope IS NOT DISTINCT FROM session_project LIMIT 1;
  IF row_id IS NULL THEN
    INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,project_scope,scope_verified,
      file_path,summary,provenance_complete)
    VALUES (p_org_id,p_session_id,p_input->>'kind',p_input->>'name',session_project,true,
      p_input->>'file_path',p_input->>'summary',true)
    RETURNING id,provenance_complete INTO row_id,row_complete;
  ELSE
    -- The original update trigger downgrades provenance on a metadata change.
    UPDATE public.knowledge_entities e SET
      file_path=CASE WHEN p_input ? 'file_path' THEN p_input->>'file_path' ELSE e.file_path END,
      summary=CASE WHEN p_input ? 'summary' THEN p_input->>'summary' ELSE e.summary END
    WHERE e.org_id=p_org_id AND e.id=row_id AND (
      (p_input ? 'file_path' AND e.file_path IS DISTINCT FROM p_input->>'file_path')
      OR (p_input ? 'summary' AND e.summary IS DISTINCT FROM p_input->>'summary'));
    SELECT provenance_complete INTO row_complete FROM public.knowledge_entities WHERE org_id=p_org_id AND id=row_id;
  END IF;
  INSERT INTO public.knowledge_entity_sessions(org_id,entity_id,session_id)
    VALUES(p_org_id,row_id,p_session_id) ON CONFLICT DO NOTHING;
  IF row_complete IS DISTINCT FROM true THEN
    PERFORM public.mark_erasure_coverage_unknown(p_org_id,'unattributed_write');
  END IF;
  RETURN row_id;
END;
$$;

CREATE FUNCTION public.write_managed_graph_edge(p_org_id uuid, p_session_id uuid, p_input jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE row_id uuid; row_complete boolean; session_project text; target_state text;
BEGIN
  PERFORM public.lock_erasure_org(p_org_id);
  SELECT state INTO target_state FROM public.session_erasure_state
    WHERE org_id=p_org_id AND session_id=p_session_id;
  IF target_state IN ('erasing','complete') THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='managed graph session is fenced';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.erasure_org_coverage c
    JOIN public.erasure_deployment d ON d.id AND d.enabled
      AND d.source_generation='managed_explicit_session_v1' AND c.activation_id=d.activation_id
    JOIN public.session_erasure_state e ON e.org_id=c.org_id AND e.session_id=p_session_id
      AND e.state='active' AND e.activation_id=d.activation_id
    WHERE c.org_id=p_org_id AND c.unknown_at IS NULL
  ) THEN RETURN NULL; END IF;
  SELECT project_scope INTO session_project FROM public.sessions
    WHERE org_id=p_org_id AND id=p_session_id AND kind='explicit';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (p_input - ARRAY['from_entity','to_entity','edge_type','project_scope','scope_verified']) <> '{}'::jsonb
    OR jsonb_typeof(p_input->'from_entity') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'to_entity') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'edge_type') IS DISTINCT FROM 'string'
    OR NOT (p_input ? 'project_scope')
    OR jsonb_typeof(p_input->'project_scope') NOT IN ('string','null')
    OR jsonb_typeof(p_input->'scope_verified') IS DISTINCT FROM 'boolean'
    OR (p_input->>'project_scope') IS DISTINCT FROM session_project THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid managed graph input';
  END IF;
  IF p_input->'scope_verified' <> 'true'::jsonb THEN RETURN NULL; END IF;
  SELECT id,provenance_complete INTO row_id,row_complete FROM public.knowledge_edges
    WHERE org_id=p_org_id AND from_entity=(p_input->>'from_entity')::uuid
      AND to_entity=(p_input->>'to_entity')::uuid AND edge_type=p_input->>'edge_type'
      AND scope_verified AND project_scope IS NOT DISTINCT FROM session_project LIMIT 1;
  IF row_id IS NULL THEN
    INSERT INTO public.knowledge_edges(org_id,session_id,from_entity,to_entity,edge_type,
      project_scope,scope_verified,provenance_complete)
    VALUES(p_org_id,p_session_id,(p_input->>'from_entity')::uuid,(p_input->>'to_entity')::uuid,
      p_input->>'edge_type',session_project,true,true)
    RETURNING id,provenance_complete INTO row_id,row_complete;
  END IF;
  INSERT INTO public.knowledge_edge_sessions(org_id,edge_id,session_id)
    VALUES(p_org_id,row_id,p_session_id) ON CONFLICT DO NOTHING;
  IF row_complete IS DISTINCT FROM true THEN
    PERFORM public.mark_erasure_coverage_unknown(p_org_id,'unattributed_write');
  END IF;
  RETURN row_id;
END;
$$;
REVOKE ALL ON FUNCTION public.write_managed_graph_entity(uuid,uuid,jsonb),
  public.write_managed_graph_edge(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,authenticator;
GRANT EXECUTE ON FUNCTION public.write_managed_graph_entity(uuid,uuid,jsonb),
  public.write_managed_graph_edge(uuid,uuid,jsonb) TO service_role;
