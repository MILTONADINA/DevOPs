-- The latest deterministic outcome for each typed fact. NULL/missing row means
-- unaudited; a manual is_suppressed flag alone never implies CONFLICT.
CREATE TABLE public.audit_statuses (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  fact_table text NOT NULL CHECK (fact_table IN
    ('function_changes', 'tech_decisions', 'policy_updates', 'todos', 'variable_changes')),
  fact_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('CONFIRMED', 'UNVERIFIED', 'CONFLICT')),
  audited_at timestamptz NOT NULL DEFAULT now(),
  evidence_commit text,
  detail text,
  PRIMARY KEY (org_id, fact_table, fact_id)
);
CREATE INDEX audit_statuses_recent_idx ON public.audit_statuses(org_id, audited_at DESC);
CREATE INDEX audit_conflicts_fact_idx ON public.audit_conflicts(org_id, fact_table, fact_id);
ALTER TABLE public.audit_statuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_statuses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.audit_statuses TO service_role;

-- One RPC transaction covers every outcome in an audit batch. A conflict also
-- suppresses its fact and appends evidence; any error rolls back the whole batch.
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
  IF p_org_id IS NULL OR p_session_id IS NULL OR p_rows IS NULL
     OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'audit result arguments are invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions
                 WHERE id = p_session_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'audit session does not belong to organization';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    fact_table := item->>'fact_table';
    outcome := item->>'status';
    IF fact_table IS NULL OR fact_table NOT IN
       ('function_changes', 'tech_decisions', 'policy_updates', 'todos', 'variable_changes') THEN
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

REVOKE EXECUTE ON FUNCTION public.persist_audit_results(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_audit_results(uuid, uuid, jsonb)
  TO service_role;

-- Older conflict-only callers also receive a status record after this migration.
CREATE OR REPLACE FUNCTION public.persist_audit_conflicts(
  p_org_id uuid, p_session_id uuid, p_rows jsonb
)
RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT public.persist_audit_results(p_org_id, p_session_id,
    COALESCE((SELECT jsonb_agg(value || jsonb_build_object('status', 'CONFLICT'))
              FROM jsonb_array_elements(p_rows)), '[]'::jsonb));
$$;
REVOKE EXECUTE ON FUNCTION public.persist_audit_conflicts(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_audit_conflicts(uuid, uuid, jsonb)
  TO service_role;
