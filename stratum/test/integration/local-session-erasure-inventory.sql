-- Disposable, read-only inventory RPC proof; every fixture row rolls back.
\set ON_ERROR_STOP on
BEGIN;

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

INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, file_path)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'File', 'a.ts', 'a.ts') RETURNING id AS entity_a \gset
INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, file_path)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, 'File', 'shared.ts', 'shared.ts') RETURNING id AS entity_shared \gset
INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, :'entity_shared'::uuid, :'entity_a'::uuid, 'REFERENCED_IN');
INSERT INTO public.memory_vectors(org_id, session_id, source_type, source_ref, embedding)
VALUES (:'org_a'::uuid, :'session_shared'::uuid, 'fact', :'fact_a',
  ('[' || array_to_string(array_fill(0, ARRAY[384]), ',') || ']')::vector);

INSERT INTO public.pruning_logs(session_id, turns_total, lambda_used, gain_shift_used, theta_used)
VALUES (:'session_a'::uuid, 1, 0.97, 0, 1) RETURNING id AS log_a \gset
INSERT INTO public.billing_records(org_id, session_id, pruning_log_id, original_tokens,
  quarantined_tokens, api_price_per_token, signed_hash)
VALUES (:'org_a'::uuid, :'session_a'::uuid, :'log_a'::uuid, 100, 20, 0.00001,
  'inventory-fixture-signature');

SELECT set_config('devops_test.erasure_inventory',
  public.inspect_session_erasure(:'org_a'::uuid, :'session_a'::uuid)::text, true) \gset

DO $$
DECLARE report jsonb := current_setting('devops_test.erasure_inventory')::jsonb;
BEGIN
  IF report->>'scope' IS DISTINCT FROM 'local_database_only'
     OR (report->'counts'->>'billing_records')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'function_changes')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'audit_statuses')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'audit_conflicts')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'source_fact_links')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_entities')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_edges')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_entity_sessions')::integer IS DISTINCT FROM 1
     OR (report->'counts'->>'knowledge_edge_sessions')::integer IS DISTINCT FROM 0
     OR (report->'counts'->>'memory_vectors')::integer IS DISTINCT FROM 1
     OR (report->>'graph_ownership') IS DISTINCT FROM 'ambiguous'
     OR (report->>'external_copies') IS DISTINCT FROM 'not_inventoried'
     OR (report->>'backups') IS DISTINCT FROM 'not_inventoried'
     OR (report->>'in_memory') IS DISTINCT FROM 'not_inventoried' THEN
    RAISE EXCEPTION 'session erasure inventory omitted a dependent data class: %', report;
  END IF;
  RAISE NOTICE 'scoped local session inventory counted billing, facts, audit, graph, source link, vector, and pruning dependencies';
END;
$$;

-- Any newly introduced public table must be classified before this inventory
-- can be treated as complete for the local database.
SELECT 1 / CASE WHEN
  (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public') =
  (SELECT array_agg(name ORDER BY name) FROM (
    SELECT jsonb_object_keys((current_setting('devops_test.erasure_inventory')::jsonb)->'counts') AS name
    UNION ALL
    SELECT jsonb_array_elements_text((current_setting('devops_test.erasure_inventory')::jsonb)->'org_only_classes')
  ) classes)
  THEN 1 ELSE 0 END AS public_table_coverage_passed;

SELECT 1 / CASE WHEN public.inspect_session_erasure(:'org_b'::uuid, :'session_a'::uuid) IS NULL
  AND public.inspect_session_erasure(:'org_a'::uuid, :'session_b'::uuid) IS NULL
  THEN 1 ELSE 0 END AS foreign_org_scope_passed;
SELECT 1 / CASE WHEN NOT has_function_privilege('anon', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.inspect_session_erasure(uuid,uuid)', 'EXECUTE')
  THEN 1 ELSE 0 END AS service_only_grants_passed;

ROLLBACK;

SELECT 1 / CASE WHEN NOT EXISTS (SELECT 1 FROM public.organizations WHERE id IN (:'org_a'::uuid, :'org_b'::uuid))
  AND NOT EXISTS (SELECT 1 FROM public.sessions WHERE id IN (:'session_a'::uuid, :'session_shared'::uuid, :'session_b'::uuid))
  AND NOT EXISTS (SELECT 1 FROM public.billing_records WHERE session_id = :'session_a'::uuid)
  THEN 1 ELSE 0 END AS fixture_rollback_passed;
