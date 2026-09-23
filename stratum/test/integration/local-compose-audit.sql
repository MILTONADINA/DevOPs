-- Local-only audit integration. Everything seeded here is rolled back.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.organizations(name) VALUES ('DevOPs Compose audit check') RETURNING id AS org_id \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_id'::uuid, 'local-check') RETURNING id AS session_id \gset
INSERT INTO public.function_changes(org_id, session_id, confidence, old_name, new_name, change_type)
VALUES (:'org_id'::uuid, :'session_id'::uuid, 0.9, 'oldFn', 'newFn', 'renamed') RETURNING id AS fact_id \gset

SELECT public.persist_audit_results(
  :'org_id'::uuid, :'session_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'fact_table', 'function_changes', 'fact_id', :'fact_id',
    'status', 'CONFLICT', 'claimed_state', 'oldFn renamed to newFn',
    'actual_state', 'newFn was deleted', 'conflict_commit', 'local-check-commit'
  ))) AS inserted \gset

SELECT set_config('devops_test.org_id', :'org_id', true),
       set_config('devops_test.fact_id', :'fact_id', true) \gset
DO $$
BEGIN
  IF current_setting('devops_test.org_id') IS NULL THEN RAISE EXCEPTION 'missing test org'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.function_changes WHERE id = current_setting('devops_test.fact_id')::uuid
      AND org_id = current_setting('devops_test.org_id')::uuid AND is_suppressed
  ) THEN RAISE EXCEPTION 'conflict did not suppress fact'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_statuses WHERE fact_id = current_setting('devops_test.fact_id')::uuid
      AND org_id = current_setting('devops_test.org_id')::uuid AND status = 'CONFLICT'
  ) THEN RAISE EXCEPTION 'conflict status missing'; END IF;
  IF (SELECT count(*) FROM public.audit_conflicts
      WHERE fact_id = current_setting('devops_test.fact_id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'conflict alert missing or duplicated';
  END IF;
  IF has_function_privilege('anon', 'public.persist_audit_results(uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.persist_audit_results(uuid,uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.persist_audit_results(uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'audit RPC grants are wrong';
  END IF;
END;
$$;
ROLLBACK;
