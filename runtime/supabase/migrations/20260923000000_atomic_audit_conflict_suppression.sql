-- Record Historical Drift evidence and suppress its typed fact in one transaction.
-- Service-role only; the caller supplies trusted org/session IDs. PostgreSQL rolls
-- back every update and insert in the function if any item raises an error.
CREATE OR REPLACE FUNCTION public.persist_audit_conflicts(
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
  affected integer;
  inserted integer := 0;
BEGIN
  IF p_org_id IS NULL OR p_session_id IS NULL OR p_rows IS NULL
     OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'audit conflict arguments are invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions
                 WHERE id = p_session_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'audit session does not belong to organization';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    fact_table := item->>'fact_table';
    IF fact_table IS NULL OR fact_table NOT IN
       ('function_changes', 'tech_decisions', 'policy_updates', 'todos', 'variable_changes') THEN
      RAISE EXCEPTION 'unsupported audit fact table: %', fact_table;
    END IF;
    fact_id := (item->>'fact_id')::uuid;
    IF fact_id IS NULL THEN
      RAISE EXCEPTION 'audit fact id is missing';
    END IF;

    EXECUTE format('UPDATE public.%I SET is_suppressed = TRUE WHERE id = $1 AND org_id = $2', fact_table)
      USING fact_id, p_org_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'audit fact is missing from organization: %.%', fact_table, fact_id;
    END IF;

    INSERT INTO public.audit_conflicts
      (id, org_id, session_id, fact_table, fact_id, claimed_state, actual_state,
       conflict_commit, suppressed)
    VALUES
      ((item->>'id')::uuid, p_org_id, p_session_id, fact_table, fact_id,
       item->>'claimed_state', item->>'actual_state', item->>'conflict_commit', TRUE)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted := inserted + affected;
  END LOOP;
  RETURN inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.persist_audit_conflicts(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_audit_conflicts(uuid, uuid, jsonb)
  TO service_role;
