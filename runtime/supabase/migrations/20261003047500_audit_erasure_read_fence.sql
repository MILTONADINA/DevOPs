-- specs/memory/session-erasure.md REQ-11, AC-B5/B6.
-- Guard the audit RPC's existing no-op path: an earlier conflict may suppress
-- every write, but a fenced source still cannot be inspected by that operation.
-- This appends to applied400; its original audit outcomes/evidence remain intact.
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
  source_session uuid;
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

  IF EXISTS(SELECT 1 FROM public.session_erasure_state st
    WHERE st.session_id=p_session_id AND st.state IN ('erasing','complete')) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure session is fenced';
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

    -- A prior CONFLICT makes later CONFIRMED/UNVERIFIED a no-op. Row triggers
    -- cannot protect that read: lock and validate its typed owner before any
    -- content row lock or the no-op branch, even when no result will be written.
    PERFORM public.lock_erasure_source('fact',fact_id);
    IF EXISTS(SELECT 1 FROM public.session_erasure_state st WHERE st.state='complete'
      AND st.erased_fact_ids @> ARRAY[fact_id]) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure source identity is retired';
    END IF;
    EXECUTE format('SELECT session_id FROM public.%I WHERE id = $1 AND org_id = $2',fact_table)
      INTO source_session USING fact_id,p_org_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'audit fact is missing from organization: %.%', fact_table, fact_id;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.sessions s WHERE s.id=source_session AND s.org_id=p_org_id) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure source ownership is unavailable';
    END IF;
    IF EXISTS(SELECT 1 FROM public.session_erasure_state st
      WHERE st.session_id=source_session AND st.state IN ('erasing','complete')) THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='erasure session is fenced';
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
