-- Disposable, read-only inventory RPC proof; every fixture row rolls back.
\set ON_ERROR_STOP on
BEGIN;

-- specs/ops/payment-removal.md REQ-8: M2 retired every invoice-only object.
SELECT 1 / CASE WHEN to_regclass('public.invoices') IS NULL
  AND to_regclass('public.invoice_send_claims') IS NULL
  AND to_regprocedure('public.reconcile_claimed_invoice(uuid,timestamptz,timestamptz,text,integer,text,timestamptz)') IS NULL
  AND to_regprocedure('public.record_invoice_payment(uuid,text,integer,text,text)') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('reconcile_claimed_invoice', 'record_invoice_payment'))
  THEN 1 ELSE 0 END AS retired_invoice_schema_absent;

INSERT INTO public.organizations(name) VALUES ('Erasure inventory A') RETURNING id AS org_a \gset
INSERT INTO public.organizations(name) VALUES ('Erasure inventory B') RETURNING id AS org_b \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_a'::uuid, 'local-check') RETURNING id AS session_a \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_a'::uuid, 'local-check') RETURNING id AS session_shared \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_b'::uuid, 'local-check') RETURNING id AS session_b \gset

INSERT INTO public.function_changes(org_id, session_id, confidence, old_name, new_name, change_type, file_path)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 1, 'old_fn', 'new_fn', 'renamed', 'a.ts')
RETURNING id AS fact_a \gset
INSERT INTO public.audit_statuses(org_id, fact_table, fact_id, status)
VALUES (:'org_a'::uuid, 'function_changes', :'fact_a'::uuid, 'CONFLICT');
INSERT INTO public.audit_conflicts(org_id, session_id, fact_table, fact_id, claimed_state, actual_state)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'function_changes', :'fact_a'::uuid, 'old_fn', 'new_fn');
INSERT INTO public.operational_references(org_id, session_id, confidence, subject, reference)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 0.9, 'recovery runbook', 'RUNBOOK_RECOVERY.md')
RETURNING id AS reference_a \gset
INSERT INTO public.audit_statuses(org_id, fact_table, fact_id, status)
VALUES (:'org_a'::uuid, 'operational_references', :'reference_a'::uuid, 'UNVERIFIED');

INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, file_path, scope_verified)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'File', 'a.ts', 'a.ts', true) RETURNING id AS entity_a \gset
INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, file_path, scope_verified)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, 'File', 'shared.ts', 'shared.ts', true) RETURNING id AS entity_shared \gset
INSERT INTO public.function_changes(org_id, session_id, confidence, old_name, change_type, file_path)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 0.9, 'active_fn', 'deprecated', 'a.ts');
INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type, scope_verified)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, :'entity_shared'::uuid, :'entity_a'::uuid, 'REFERENCED_IN', true);
INSERT INTO public.memory_vectors(org_id, session_id, source_type, source_ref, embedding)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, 'fact', :'fact_a',
  ('[' || array_to_string(array_fill(0, ARRAY[384]), ',') || ']')::vector);
INSERT INTO public.memory_vectors(org_id, session_id, source_type, source_ref, embedding)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'fact', :'reference_a',
  ('[' || array_to_string(array_fill(0, ARRAY[384]), ',') || ']')::vector);

INSERT INTO public.pruning_logs(session_id, turns_total, lambda_used, gain_shift_used, theta_used)
VALUES (:'session_a'::uuid, 1, 0.97, 0, 1) RETURNING id AS log_a \gset
INSERT INTO public.billing_records(org_id, session_id, pruning_log_id, original_tokens,
  quarantined_tokens, api_price_per_token)
VALUES (:'org_a'::uuid, :'session_a'::uuid, :'log_a'::uuid, 100, 20, 0.00001);

SELECT set_config('devops_test.erasure_inventory',
  public.inspect_session_erasure(:'org_a'::uuid, :'session_a'::uuid)::text, true) \gset

DO $$
DECLARE report jsonb := current_setting('devops_test.erasure_inventory')::jsonb;
BEGIN
  IF report->>'scope' IS DISTINCT FROM 'local_database_only'
     OR jsonb_typeof(report->'counts'->'billing_records') IS DISTINCT FROM 'number'
     OR (report->'counts'->>'billing_records')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'function_changes')::integer IS DISTINCT FROM 2
     OR (report->'counts'->>'operational_references')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'audit_statuses')::integer IS DISTINCT FROM 2
     OR (report->'counts'->>'audit_conflicts')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'source_fact_links')::integer IS DISTINCT FROM 2
     OR (report->'counts'->>'knowledge_entities')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_edges')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_entity_sessions')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_edge_sessions')::integer IS DISTINCT FROM 0
     OR (report->'counts'->>'memory_vectors')::integer IS DISTINCT FROM 2
     OR (report->>'graph_ownership') IS DISTINCT FROM 'ambiguous'
     OR (report->>'unattributed_graph') IS DISTINCT FROM 'not_inventoried'
     OR (report->>'external_copies') IS DISTINCT FROM 'not_inventoried'
     OR (report->>'backups') IS DISTINCT FROM 'not_inventoried'
     OR (report->>'in_memory') IS DISTINCT FROM 'not_inventoried' THEN
    RAISE EXCEPTION 'session erasure inventory omitted a dependent data class: %', report;
  END IF;
  RAISE NOTICE 'scoped local session inventory counted billing, facts, audit, graph, source link, vector, and pruning dependencies';
END;
$$;

-- Positive usage is ordinary session data; zero is also a JSON number.
-- The second organization's existing session has no usage rows.
SELECT 1 / CASE WHEN
  public.inspect_session_erasure(:'org_b'::uuid, :'session_b'::uuid)->>'scope' = 'local_database_only'
  AND public.inspect_session_erasure(:'org_b'::uuid, :'session_b'::uuid)->>'org_id' = :'org_b'
  AND public.inspect_session_erasure(:'org_b'::uuid, :'session_b'::uuid)->>'session_id' = :'session_b'
  AND jsonb_typeof(public.inspect_session_erasure(:'org_b'::uuid, :'session_b'::uuid)->'counts'->'billing_records') = 'number'
  AND public.inspect_session_erasure(:'org_b'::uuid, :'session_b'::uuid)->'counts'->'billing_records' = '0'::jsonb
  THEN 1 ELSE 0 END AS empty_usage_inventory_is_numeric;

SELECT 1 / CASE WHEN
  current_setting('devops_test.erasure_inventory')::jsonb->'org_only_classes' =
    '["api_keys", "developers", "org_config", "organizations"]'::jsonb
  THEN 1 ELSE 0 END AS retained_org_only_classes_passed;

-- C4-B authority survives erasure; it is neither active session content nor an
-- application backup payload. Keep every existing class assertion above.
SELECT 1 / CASE WHEN
  current_setting('devops_test.erasure_inventory')::jsonb->'retained_metadata_classes' =
    '["erasure_deployment", "erasure_org_coverage", "session_erasure_state"]'::jsonb
  THEN 1 ELSE 0 END AS retained_erasure_metadata_classes_passed;

-- Any newly introduced public table must be classified before this inventory
-- can be treated as complete for the local database.
SELECT 1 / CASE WHEN
  (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public') =
  (SELECT array_agg(name ORDER BY name) FROM (
    SELECT jsonb_object_keys((current_setting('devops_test.erasure_inventory')::jsonb)->'counts') AS name
    UNION ALL
    SELECT jsonb_array_elements_text((current_setting('devops_test.erasure_inventory')::jsonb)->'org_only_classes')
    UNION ALL
    SELECT jsonb_array_elements_text((current_setting('devops_test.erasure_inventory')::jsonb)->'retained_metadata_classes')
  ) classes)
  THEN 1 ELSE 0 END AS public_table_coverage_passed;

SELECT 1 / CASE WHEN public.inspect_session_erasure(:'org_b'::uuid, :'session_a'::uuid) IS NULL
  AND public.inspect_session_erasure(:'org_a'::uuid, :'session_b'::uuid) IS NULL
  THEN 1 ELSE 0 END AS foreign_org_scope_passed;
SELECT 1 / CASE WHEN NOT has_function_privilege('anon', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  THEN 1 ELSE 0 END AS service_only_grants_passed;

-- CREATE OR REPLACE must retain the inventory's service-only invoker contract.
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = 'public.inspect_session_erasure(uuid,uuid)'::regprocedure
    AND l.lanname = 'sql' AND p.provolatile = 's' AND NOT p.prosecdef
    AND p.proconfig @> ARRAY['search_path=""']::text[]
    AND NOT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_records'::regclass)
  THEN 1 ELSE 0 END AS retained_inventory_security_passed;

ROLLBACK;

SELECT 1 / CASE WHEN NOT EXISTS (SELECT 1 FROM public.organizations WHERE id IN (:'org_a'::uuid, :'org_b'::uuid))
  AND NOT EXISTS (SELECT 1 FROM public.sessions WHERE id IN (:'session_a'::uuid, :'session_shared'::uuid, :'session_b'::uuid))
  AND NOT EXISTS (SELECT 1 FROM public.billing_records WHERE session_id = :'session_a'::uuid)
  THEN 1 ELSE 0 END AS fixture_rollback_passed;
