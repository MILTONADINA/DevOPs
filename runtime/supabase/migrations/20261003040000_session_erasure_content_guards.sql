-- specs/memory/session-erasure.md REQ-11/14, AC-B5/B6/B12.
-- Default-disabled authority remains unchanged. Serialize every actual owner and
-- generic source identity; uncertainty never bypasses a retained source tombstone.
CREATE FUNCTION public.lock_erasure_source(p_kind text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_kind IS NULL OR p_kind NOT IN ('fact','entity') OR p_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid erasure source identity';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('erasure_source:'||p_kind||':'||p_id::text)::bigint);
END;
$$;
CREATE FUNCTION public.erasure_source_uuid(p_ref text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
BEGIN
  RETURN p_ref::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;

-- This guard is deliberately INVOKER. A definer trigger would mistake its own
-- effective role for the future executor and grant every caller the DELETE bypass.
CREATE FUNCTION public.guard_session_erasure_content() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  old_row jsonb; new_row jsonb; item jsonb; rows jsonb;
  org uuid; candidate_org uuid; owner_session uuid; sessions uuid[] := '{}';
  refs jsonb := '[]'; ref jsonb; ref_id uuid; ref_kind text; ref_table text;
  source_row record; graph_row record; source_count integer; own_count integer;
  covered boolean; uncertain boolean := false; deleting boolean;
  identity boolean; source_missing boolean; pair_changed boolean;
  allowed_tables constant text[] := ARRAY['function_changes','tech_decisions','policy_updates',
    'todos','variable_changes','operational_references'];
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF TG_OP <> 'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
  item:=coalesce(new_row,old_row);
  IF TG_TABLE_NAME='pruning_logs' THEN
    SELECT s.org_id INTO org FROM public.sessions s WHERE s.id=(item->>'session_id')::uuid;
  ELSE org:=(item->>'org_id')::uuid;
  END IF;
  IF org IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure ownership is unavailable';
  END IF;
  PERFORM public.lock_erasure_org(org);
  SELECT c.unknown_at IS NULL AND d.enabled AND c.activation_id=d.activation_id
    AND d.source_generation='managed_explicit_session_v1'
    INTO covered FROM public.erasure_org_coverage c CROSS JOIN public.erasure_deployment d
    WHERE c.org_id=org AND d.id;
  covered:=coalesce(covered,false);
  deleting:=TG_OP='DELETE' AND current_user='devops_erasure_executor';
  -- Actual execution explicitly deletes every captured dependent before parents.
  -- An unexpected nonempty implicit cascade is not executor authorization.
  IF deleting AND pg_trigger_depth()>1 THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='unexpected erasure cascade';
  END IF;
  IF TG_OP='UPDATE' AND old_row->'org_id' IS DISTINCT FROM new_row->'org_id' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure organization identity is immutable';
  END IF;
  rows:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(new_row)
    WHEN 'DELETE' THEN jsonb_build_array(old_row) ELSE jsonb_build_array(old_row,new_row) END;

  -- Resolve direct and edge-derived references under the org lock, then lock the
  -- complete canonical source set before reading any generic source/tombstone.
  FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
    owner_session:=(item->>'session_id')::uuid;
    IF owner_session IS NOT NULL THEN sessions:=array_append(sessions,owner_session); END IF;
    IF TG_TABLE_NAME=ANY(allowed_tables) THEN
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',item->>'id','identity',true));
      IF TG_TABLE_NAME='tech_decisions' AND item->>'supersedes_id' IS NOT NULL THEN
        refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',item->>'supersedes_id','table','tech_decisions'));
      END IF;
    ELSIF TG_TABLE_NAME='billing_records' AND item->>'pruning_log_id' IS NOT NULL THEN
      SELECT p.session_id,s.org_id INTO owner_session,candidate_org
        FROM public.pruning_logs p JOIN public.sessions s ON s.id=p.session_id
        WHERE p.id=(item->>'pruning_log_id')::uuid;
      IF NOT FOUND OR candidate_org IS DISTINCT FROM org THEN
        RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure pruning ownership is unavailable';
      END IF;
      sessions:=array_append(sessions,owner_session);
    ELSIF TG_TABLE_NAME IN ('audit_statuses','audit_conflicts') THEN
      IF item->>'fact_table' IS NULL OR NOT (item->>'fact_table'=ANY(allowed_tables)) THEN
        RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure audit source is unsupported';
      END IF;
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',item->>'fact_id','table',item->>'fact_table'));
    ELSIF TG_TABLE_NAME='memory_vectors' THEN
      ref_id:=public.erasure_source_uuid(item->>'source_ref');
      IF item->>'source_type' IN ('fact','entity') THEN
        IF ref_id IS NULL OR (covered AND ref_id::text IS DISTINCT FROM item->>'source_ref') THEN
          IF covered THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure vector source is unresolved'; END IF;
          uncertain:=true;
        END IF;
        IF ref_id IS NOT NULL THEN
          refs:=refs||jsonb_build_array(jsonb_build_object('kind',item->>'source_type','id',ref_id));
        END IF;
      ELSE
        -- No persisted turn-source table proves this class. Preserve unknown
        -- legacy inputs, but relabeling a retired UUID as turn cannot revive it.
        uncertain:=true;
        IF ref_id IS NOT NULL THEN
          refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',ref_id,'retired_only',true),
            jsonb_build_object('kind','entity','id',ref_id,'retired_only',true));
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME='knowledge_entities' THEN
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','entity','id',item->>'id','identity',true));
      IF owner_session IS NULL OR NOT (item->>'provenance_complete')::boolean THEN uncertain:=true; END IF;
      FOR owner_session IN SELECT p.session_id FROM public.knowledge_entity_sessions p
        WHERE p.org_id=org AND p.entity_id=(item->>'id')::uuid LOOP
        sessions:=array_append(sessions,owner_session);
      END LOOP;
    ELSIF TG_TABLE_NAME='knowledge_edges' THEN
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','entity','id',item->>'from_entity'),
        jsonb_build_object('kind','entity','id',item->>'to_entity'));
      IF owner_session IS NULL OR NOT (item->>'provenance_complete')::boolean THEN uncertain:=true; END IF;
      FOR owner_session IN SELECT p.session_id FROM public.knowledge_edge_sessions p
        WHERE p.org_id=org AND p.edge_id=(item->>'id')::uuid LOOP
        sessions:=array_append(sessions,owner_session);
      END LOOP;
    ELSIF TG_TABLE_NAME='knowledge_entity_sessions' THEN
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','entity','id',item->>'entity_id'));
    ELSIF TG_TABLE_NAME='knowledge_edge_sessions' THEN
      SELECT e.org_id,e.session_id,e.from_entity,e.to_entity,e.provenance_complete INTO graph_row
        FROM public.knowledge_edges e WHERE e.id=(item->>'edge_id')::uuid;
      IF NOT FOUND THEN
        -- A genuine unknown legacy FK cascade sees its parent already removed.
        IF covered OR TG_OP<>'DELETE' THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure edge ownership is unavailable';
        END IF;
        uncertain:=true;
      ELSE
        IF graph_row.org_id IS DISTINCT FROM org THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure edge ownership is unavailable';
        END IF;
        IF graph_row.session_id IS NOT NULL THEN sessions:=array_append(sessions,graph_row.session_id); END IF;
        IF graph_row.session_id IS NULL OR NOT graph_row.provenance_complete THEN uncertain:=true; END IF;
        refs:=refs||jsonb_build_array(jsonb_build_object('kind','entity','id',graph_row.from_entity),
          jsonb_build_object('kind','entity','id',graph_row.to_entity));
        FOR owner_session IN SELECT p.session_id FROM public.knowledge_edge_sessions p
          WHERE p.org_id=org AND p.edge_id=(item->>'edge_id')::uuid LOOP
          sessions:=array_append(sessions,owner_session);
        END LOOP;
      END IF;
    ELSIF TG_TABLE_NAME='source_fact_links' THEN
      refs:=refs||jsonb_build_array(jsonb_build_object('kind','entity','id',item->>'file_entity_id'));
      IF item->>'function_change_id' IS NOT NULL THEN
        refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',item->>'function_change_id','table','function_changes'));
      END IF;
      IF item->>'tech_decision_id' IS NOT NULL THEN
        refs:=refs||jsonb_build_array(jsonb_build_object('kind','fact','id',item->>'tech_decision_id','table','tech_decisions'));
      END IF;
    END IF;
  END LOOP;
  FOR ref IN SELECT value FROM jsonb_array_elements(refs)
    ORDER BY value->>'kind',value->>'id',value LOOP
    PERFORM public.lock_erasure_source(ref->>'kind',(ref->>'id')::uuid);
  END LOOP;
  FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
    ref_kind:=ref->>'kind'; ref_id:=(ref->>'id')::uuid; ref_table:=ref->>'table';
    identity:=coalesce((ref->>'identity')::boolean,false);
    IF EXISTS(SELECT 1 FROM public.session_erasure_state st WHERE st.state='complete'
      AND CASE ref_kind WHEN 'fact' THEN st.erased_fact_ids @> ARRAY[ref_id]
        ELSE st.erased_entity_ids @> ARRAY[ref_id] END) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure source identity is retired';
    END IF;
    source_count:=0; own_count:=0;
    IF ref_kind='fact' THEN
      FOR source_row IN
        SELECT 'function_changes'::text AS fact_table,f.org_id,f.session_id FROM public.function_changes f WHERE f.id=ref_id
        UNION ALL SELECT 'tech_decisions',f.org_id,f.session_id FROM public.tech_decisions f WHERE f.id=ref_id
        UNION ALL SELECT 'policy_updates',f.org_id,f.session_id FROM public.policy_updates f WHERE f.id=ref_id
        UNION ALL SELECT 'todos',f.org_id,f.session_id FROM public.todos f WHERE f.id=ref_id
        UNION ALL SELECT 'variable_changes',f.org_id,f.session_id FROM public.variable_changes f WHERE f.id=ref_id
        UNION ALL SELECT 'operational_references',f.org_id,f.session_id FROM public.operational_references f WHERE f.id=ref_id
      LOOP
        source_count:=source_count+1;
        IF identity THEN
          IF source_row.fact_table=TG_TABLE_NAME AND source_row.org_id=org
            AND (TG_OP<>'INSERT' OR source_row.session_id=(new_row->>'session_id')::uuid) THEN
            own_count:=own_count+1;
            sessions:=array_append(sessions,source_row.session_id);
          ELSIF covered THEN
            RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure fact identity is ambiguous';
          ELSE
            IF EXISTS(SELECT 1 FROM public.session_erasure_state st WHERE st.session_id=source_row.session_id AND st.state IN ('erasing','complete')) THEN
              RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure fact identity is fenced';
            END IF;
            uncertain:=true;
          END IF;
        ELSE
          IF source_row.org_id IS DISTINCT FROM org THEN
            RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure fact ownership is unavailable';
          END IF;
          IF ref_table IS NULL OR source_row.fact_table=ref_table THEN
            own_count:=own_count+1; sessions:=array_append(sessions,source_row.session_id);
          END IF;
        END IF;
      END LOOP;
      IF NOT identity AND (source_count<>1 OR own_count<>1) THEN
        IF covered AND NOT coalesce((ref->>'retired_only')::boolean,false) THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure fact source is unresolved';
        END IF;
        uncertain:=true;
      END IF;
    ELSE
      SELECT e.org_id,e.session_id,e.provenance_complete INTO graph_row
        FROM public.knowledge_entities e WHERE e.id=ref_id;
      source_missing:=NOT FOUND;
      IF NOT source_missing THEN
        IF graph_row.org_id IS DISTINCT FROM org THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure entity ownership is unavailable';
        END IF;
        IF graph_row.session_id IS NOT NULL THEN sessions:=array_append(sessions,graph_row.session_id); END IF;
        IF graph_row.session_id IS NULL OR NOT graph_row.provenance_complete THEN uncertain:=true; END IF;
        FOR owner_session IN SELECT p.session_id FROM public.knowledge_entity_sessions p
          WHERE p.org_id=org AND p.entity_id=ref_id LOOP
          sessions:=array_append(sessions,owner_session);
        END LOOP;
      ELSIF NOT identity THEN
        IF covered AND NOT coalesce((ref->>'retired_only')::boolean,false) THEN
          RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure entity source is unresolved';
        END IF;
        uncertain:=true;
      END IF;
    END IF;
  END LOOP;
  FOR owner_session IN SELECT DISTINCT unnest(sessions) LOOP
    SELECT s.org_id INTO candidate_org FROM public.sessions s WHERE s.id=owner_session;
    IF NOT FOUND OR candidate_org IS DISTINCT FROM org THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure session ownership is unavailable';
    END IF;
    IF NOT deleting AND EXISTS(SELECT 1 FROM public.session_erasure_state st
      WHERE st.session_id=owner_session AND st.state IN ('erasing','complete')) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure session is fenced';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.session_erasure_state st JOIN public.erasure_deployment d ON d.id
      WHERE st.org_id=org AND st.session_id=owner_session AND st.activation_id=d.activation_id) THEN
      uncertain:=true;
    END IF;
  END LOOP;
  IF covered AND TG_OP='UPDATE' THEN
    pair_changed:=old_row->'id' IS DISTINCT FROM new_row->'id'
      OR old_row->'session_id' IS DISTINCT FROM new_row->'session_id';
    IF TG_TABLE_NAME='memory_vectors' THEN
      pair_changed:=pair_changed OR (old_row->'source_type',old_row->'source_ref') IS DISTINCT FROM (new_row->'source_type',new_row->'source_ref');
    ELSIF TG_TABLE_NAME IN ('audit_conflicts','audit_statuses') THEN
      pair_changed:=pair_changed OR (old_row->'fact_table',old_row->'fact_id') IS DISTINCT FROM (new_row->'fact_table',new_row->'fact_id');
    ELSIF TG_TABLE_NAME='billing_records' THEN
      pair_changed:=pair_changed OR old_row->'pruning_log_id' IS DISTINCT FROM new_row->'pruning_log_id';
    ELSIF TG_TABLE_NAME='knowledge_edges' THEN
      pair_changed:=pair_changed OR (old_row->'from_entity',old_row->'to_entity') IS DISTINCT FROM (new_row->'from_entity',new_row->'to_entity');
    ELSIF TG_TABLE_NAME IN ('knowledge_entity_sessions','knowledge_edge_sessions','source_fact_links') THEN
      pair_changed:=pair_changed OR old_row IS DISTINCT FROM new_row;
    END IF;
    IF pair_changed THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure content ownership is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' AND NOT deleting AND (TG_TABLE_NAME=ANY(allowed_tables)
    OR TG_TABLE_NAME IN ('knowledge_entities','knowledge_edges','knowledge_entity_sessions','knowledge_edge_sessions','source_fact_links')) THEN
    uncertain:=true;
  END IF;
  IF uncertain AND NOT deleting THEN PERFORM public.mark_erasure_coverage_unknown(org,'unattributed_write'); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- AFTER observes the final row produced by the existing monotonic BEFORE guard,
-- and sorts after the original AFTER origin-provenance/source-link triggers.
CREATE FUNCTION public.guard_erasure_graph_completeness() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF NOT NEW.provenance_complete OR NEW.session_id IS NULL THEN
    PERFORM public.mark_erasure_coverage_unknown(NEW.org_id,'unattributed_write');
  ELSIF TG_TABLE_NAME='knowledge_entities' THEN
    IF NOT EXISTS(SELECT 1 FROM public.knowledge_entity_sessions p
      WHERE p.org_id=NEW.org_id AND p.entity_id=NEW.id AND p.session_id=NEW.session_id) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure origin provenance is unavailable';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.knowledge_edge_sessions p
    WHERE p.org_id=NEW.org_id AND p.edge_id=NEW.id AND p.session_id=NEW.session_id) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure origin provenance is unavailable';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos',
    'variable_changes','operational_references','pruning_logs','billing_records','audit_conflicts',
    'audit_statuses','memory_vectors','knowledge_entities','knowledge_edges','knowledge_entity_sessions',
    'knowledge_edge_sessions','source_fact_links'] LOOP
    EXECUTE format('CREATE TRIGGER a_session_erasure_content BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_session_erasure_content()',table_name);
  END LOOP;
END $$;
CREATE TRIGGER z_erasure_graph_completeness AFTER INSERT OR UPDATE ON public.knowledge_entities
  FOR EACH ROW EXECUTE FUNCTION public.guard_erasure_graph_completeness();
CREATE TRIGGER z_erasure_graph_completeness AFTER INSERT OR UPDATE ON public.knowledge_edges
  FOR EACH ROW EXECUTE FUNCTION public.guard_erasure_graph_completeness();

REVOKE ALL ON FUNCTION public.lock_erasure_source(text,uuid),public.erasure_source_uuid(text),
  public.guard_session_erasure_content(),public.guard_erasure_graph_completeness()
  FROM PUBLIC,anon,authenticated,authenticator;
GRANT EXECUTE ON FUNCTION public.lock_erasure_source(text,uuid),public.erasure_source_uuid(text),
  public.guard_session_erasure_content(),public.guard_erasure_graph_completeness()
  TO service_role,devops_erasure_executor;

-- Preserve atomic audit and reviewed supersession contracts; acquire the org
-- lock before their existing first content row lock or mutation.
CREATE OR REPLACE FUNCTION public.persist_audit_results(
  p_org_id uuid, p_session_id uuid, p_rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  item jsonb;
  fact_table text;
  fact_id uuid;
  outcome text;
  was_suppressed boolean;
  inserted integer := 0;
  affected integer;
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_org_id IS NULL OR p_session_id IS NULL OR p_rows IS NULL
     OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'audit result arguments are invalid';
  END IF;
  PERFORM public.lock_erasure_org(p_org_id);
  IF NOT EXISTS (SELECT 1 FROM public.sessions
                 WHERE id = p_session_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'audit session does not belong to organization';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    fact_table := item->>'fact_table';
    outcome := item->>'status';
    IF fact_table IS NULL OR fact_table NOT IN
       ('function_changes', 'tech_decisions', 'policy_updates', 'todos', 'variable_changes', 'operational_references') THEN
      RAISE EXCEPTION 'unsupported audit fact table: %', fact_table;
    END IF;
    IF outcome IS NULL OR outcome NOT IN ('CONFIRMED', 'UNVERIFIED', 'CONFLICT') THEN
      RAISE EXCEPTION 'unsupported audit outcome: %', outcome;
    END IF;
    fact_id := (item->>'fact_id')::uuid;
    IF fact_id IS NULL THEN
      RAISE EXCEPTION 'audit fact id is missing';
    END IF;

    EXECUTE format('SELECT is_suppressed FROM public.%I WHERE id = $1 AND org_id = $2 FOR UPDATE', fact_table)
      INTO was_suppressed USING fact_id, p_org_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'audit fact is missing from organization: %.%', fact_table, fact_id;
    END IF;

    IF outcome = 'CONFLICT' THEN
      EXECUTE format('UPDATE public.%I SET is_suppressed = TRUE WHERE id = $1 AND org_id = $2', fact_table)
        USING fact_id, p_org_id;
      INSERT INTO public.audit_conflicts
        (id, org_id, session_id, fact_table, fact_id, claimed_state, actual_state,
         conflict_commit, suppressed)
      VALUES
        ((item->>'id')::uuid, p_org_id, p_session_id, fact_table, fact_id,
         item->>'claimed_state', item->>'actual_state', item->>'conflict_commit', TRUE)
      ON CONFLICT (id) DO NOTHING;
      GET DIAGNOSTICS affected = ROW_COUNT;
      inserted := inserted + affected;
    END IF;

    -- A later non-conflict run cannot overwrite a prior CONFLICT. Manual
    -- suppression alone is not a conflict and may still receive an audit result.
    IF outcome = 'CONFLICT' OR NOT EXISTS (
      SELECT 1 FROM public.audit_conflicts c
      WHERE c.org_id = p_org_id AND c.fact_table = item->>'fact_table'
        AND c.fact_id = (item->>'fact_id')::uuid
    ) THEN
      INSERT INTO public.audit_statuses
        (org_id, fact_table, fact_id, status, evidence_commit, detail)
      VALUES
        (p_org_id, fact_table, fact_id, outcome,
         CASE WHEN outcome = 'CONFLICT' THEN item->>'conflict_commit' ELSE item->>'evidence_commit' END,
         CASE WHEN outcome = 'CONFLICT' THEN item->>'actual_state' ELSE NULL END)
      ON CONFLICT ON CONSTRAINT audit_statuses_pkey DO UPDATE SET
        status = EXCLUDED.status,
        audited_at = now(),
        evidence_commit = EXCLUDED.evidence_commit,
        detail = EXCLUDED.detail;
    END IF;
  END LOOP;
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_tech_decision_supersession(
  match_org uuid, match_project_scope text, newer_id uuid, older_id uuid,
  reviewer text, evidence text
) RETURNS uuid
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE linked uuid;
BEGIN
  PERFORM public.lock_erasure_org(match_org);
  UPDATE public.tech_decisions
    SET supersedes_id = older_id,
        supersession_reviewer = reviewer,
        supersession_evidence = evidence,
        supersession_reviewed_at = statement_timestamp()
    WHERE id = newer_id AND org_id = match_org
      AND project_scope IS NOT DISTINCT FROM match_project_scope
      AND supersedes_id IS NULL AND NOT is_suppressed
    RETURNING id INTO linked;
  IF linked IS NULL THEN
    RAISE EXCEPTION 'newer active decision missing, scope mismatch, or already linked';
  END IF;
  RETURN linked;
END;
$$;
