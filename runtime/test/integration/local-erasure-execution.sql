-- specs/memory/session-erasure.md AC-B6/B7/B8/B9/B10/B13: substantive SQL unit.
-- Root runs only in isolated c4b-erasure. This rollback unit is NOT real HTTP,
-- committed-fence or cross-connection proof; those remain separate required gates.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_erasure(condition boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%',message; END IF;
END; $$;
CREATE FUNCTION pg_temp.expect_erasure_error(statement text,expected_state text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE actual_state text; BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state IS DISTINCT FROM expected_state THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected erasure refusal with SQLSTATE %',expected_state;
END; $$;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
    (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
END; $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_erasure(boolean,text),
  pg_temp.expect_erasure_error(text,text) TO service_role;
BEGIN;
SET LOCAL statement_timeout='15s';
SELECT pg_temp.assert_erasure(
  to_regprocedure('public.inspect_managed_session_erasure(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('public.prepare_session_erasure(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('public.execute_session_erasure(uuid,uuid)') IS NOT NULL,
  'AC-B7: scoped preparation/execution RPCs are absent');

-- Public results are service-only; raw captured identity plans remain private.
DO $$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['public.inspect_managed_session_erasure(uuid,uuid)',
    'public.prepare_session_erasure(uuid,uuid)','public.execute_session_erasure(uuid,uuid)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature::regprocedure AND prosecdef
      AND proowner='devops_erasure_executor'::regrole AND proconfig @> ARRAY['search_path=""'])
      OR has_function_privilege('anon',signature,'EXECUTE')
      OR has_function_privilege('authenticated',signature,'EXECUTE')
      OR has_function_privilege('authenticator',signature,'EXECUTE')
      OR NOT has_function_privilege('service_role',signature,'EXECUTE') THEN
      RAISE EXCEPTION 'unsafe erasure public RPC privileges';
    END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['public.build_session_erasure_plan(uuid,uuid)',
    'public.lock_session_erasure_request(uuid,uuid)'] LOOP
    IF has_function_privilege('service_role',signature,'EXECUTE')
      OR has_function_privilege('anon',signature,'EXECUTE')
      OR has_function_privilege('authenticated',signature,'EXECUTE')
      OR has_function_privilege('authenticator',signature,'EXECUTE')
      OR EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=signature::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'private erasure helper exposed';
    END IF;
  END LOOP;
  IF has_column_privilege('devops_erasure_executor','public.erasure_deployment','enabled','UPDATE')
    OR has_column_privilege('devops_erasure_executor','public.erasure_deployment','activation_id','UPDATE')
    OR has_column_privilege('devops_erasure_executor','public.erasure_deployment','source_generation','UPDATE')
    OR has_schema_privilege('devops_erasure_executor','public','CREATE')
    OR has_table_privilege('devops_erasure_executor','public.organizations','DELETE')
    OR has_table_privilege('devops_erasure_executor','public.sessions','UPDATE')
    OR pg_has_role('service_role','devops_erasure_executor','SET') THEN
    RAISE EXCEPTION 'erasure executor authority expanded beyond fixed operations';
  END IF;
END; $$;

-- Default-disabled deployment still refuses normal sessions.
SET LOCAL ROLE service_role;
SELECT id AS disabled_org FROM public.create_managed_organization('Erasure disabled SQL fixture','growth') \gset
SELECT id AS disabled_session FROM public.create_session_if_under_cap(:'disabled_org','fixture',2) \gset
SELECT pg_temp.assert_erasure(
  public.inspect_managed_session_erasure(:'disabled_org',:'disabled_session')->>'status'='blocked'
  AND public.prepare_session_erasure(:'disabled_org',:'disabled_session')->'reasons' ? 'deployment_unverified',
  'disabled deployment reported ready');
RESET ROLE;
-- Privileged activation only for this rollback unit. Normal creation/writes below.
UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),activated_at=clock_timestamp(),
  source_manifest_sha256=repeat('a',64) WHERE id; -- Synthetic SQL unit digest; no artifact attestation.
SET LOCAL ROLE service_role;
SELECT id AS org FROM public.create_managed_organization('Erasure substantive SQL fixture','growth') \gset
SELECT id AS target FROM public.create_project_session_if_under_cap(:'org','target',5,'orion') \gset
SELECT id AS survivor FROM public.create_project_session_if_under_cap(:'org','survivor',5,'orion') \gset
SELECT id AS foreign_org FROM public.create_managed_organization('Erasure foreign SQL fixture','growth') \gset
SELECT id AS foreign_session FROM public.create_session_if_under_cap(:'foreign_org','foreign',2) \gset

-- Normal graph writer establishes complete exclusive and shared provenance.
SELECT public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"File","name":"private.ts","file_path":"private.ts","project_scope":"orion","scope_verified":true}') AS private_file \gset
SELECT public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"Function","name":"private_fn","project_scope":"orion","scope_verified":true}') AS private_fn \gset
SELECT public.write_managed_graph_edge(:'org',:'target',jsonb_build_object(
  'from_entity',:'private_file','to_entity',:'private_fn','edge_type','DECLARES','project_scope','orion','scope_verified',true)) AS private_edge \gset
SELECT public.write_managed_graph_entity(:'org',:'survivor',
  '{"kind":"File","name":"shared.ts","file_path":"shared.ts","project_scope":"orion","scope_verified":true}') AS shared_file \gset
SELECT public.write_managed_graph_entity(:'org',:'survivor',
  '{"kind":"Function","name":"shared_fn","project_scope":"orion","scope_verified":true}') AS shared_fn \gset
SELECT public.write_managed_graph_edge(:'org',:'survivor',jsonb_build_object(
  'from_entity',:'shared_file','to_entity',:'shared_fn','edge_type','DECLARES','project_scope','orion','scope_verified',true)) AS shared_edge \gset
SELECT pg_temp.assert_erasure(public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"File","name":"shared.ts","file_path":"shared.ts","project_scope":"orion","scope_verified":true}')=:'shared_file'::uuid
  AND public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"Function","name":"shared_fn","project_scope":"orion","scope_verified":true}')=:'shared_fn'::uuid
  AND public.write_managed_graph_edge(:'org',:'target',jsonb_build_object(
  'from_entity',:'shared_file','to_entity',:'shared_fn','edge_type','DECLARES','project_scope','orion','scope_verified',true))=:'shared_edge'::uuid,
  'ordinary graph reuse did not preserve shared rows');

INSERT INTO public.function_changes(org_id,session_id,confidence,old_name,change_type,file_path,project_scope)
VALUES(:'org',:'target',1,'private_fn','deprecated','private.ts','orion') RETURNING id AS fc \gset
INSERT INTO public.tech_decisions(org_id,session_id,confidence,decision_text,domain,project_scope,created_at)
VALUES(:'org',:'target',1,'original decision','private.ts','orion','2026-01-01') RETURNING id AS td_old \gset
INSERT INTO public.tech_decisions(org_id,session_id,confidence,decision_text,domain,project_scope,created_at)
VALUES(:'org',:'target',1,'replacement decision','private.ts','orion','2026-02-01') RETURNING id AS td_new \gset
SELECT public.review_tech_decision_supersession(:'org','orion',:'td_new',:'td_old',
  'fixture operator','reviewed fixture replacement evidence');
INSERT INTO public.policy_updates(org_id,session_id,confidence,policy_name,new_value,policy_type,project_scope)
VALUES(:'org',:'target',1,'private policy','required','process','orion') RETURNING id AS pu \gset
INSERT INTO public.todos(org_id,session_id,confidence,description,project_scope)
VALUES(:'org',:'target',1,'private task','orion') RETURNING id AS todo \gset
INSERT INTO public.variable_changes(org_id,session_id,confidence,var_name,new_value,project_scope)
VALUES(:'org',:'target',1,'private variable','value','orion') RETURNING id AS vc \gset
INSERT INTO public.operational_references(org_id,session_id,confidence,subject,reference,project_scope)
VALUES(:'org',:'target',1,'private runbook','private.md','orion') RETURNING id AS op \gset
INSERT INTO public.function_changes(org_id,session_id,confidence,old_name,change_type,file_path,project_scope)
VALUES(:'org',:'survivor',1,'shared_fn','deprecated','shared.ts','orion') RETURNING id AS survivor_fact \gset
SELECT gen_random_uuid() AS conflict_id \gset
SELECT public.persist_audit_results(:'org',:'survivor',jsonb_build_array(jsonb_build_object(
  'id',:'conflict_id','fact_table','todos','fact_id',:'todo','status','CONFLICT',
  'claimed_state','private task complete','actual_state','private task pending','conflict_commit','fixture')));
INSERT INTO public.audit_conflicts(org_id,session_id,fact_table,fact_id,claimed_state,actual_state)
VALUES(:'org',:'target','function_changes',:'survivor_fact','shared claimed','shared actual') RETURNING id AS own_audit \gset
SELECT ('['||array_to_string(array_fill(0,ARRAY[384]),',')||']') AS embedding \gset
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',NULL,'fact',:'fc',:'embedding'::vector) RETURNING id AS vector_fact \gset
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',:'survivor','fact',:'pu',:'embedding'::vector) RETURNING id AS vector_other_pointer \gset
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',NULL,'entity',:'private_fn',:'embedding'::vector) RETURNING id AS vector_entity \gset
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',:'survivor','entity',:'shared_file',:'embedding'::vector) RETURNING id AS vector_survivor \gset
INSERT INTO public.pruning_logs(session_id,turns_total,turns_selected,turns_pruned,lambda_used,gain_shift_used,theta_used)
VALUES(:'target',3,'{0,2}','{1}',0.97,0,1) RETURNING id AS pruning \gset
INSERT INTO public.billing_records(org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token)
VALUES(:'org',:'target',:'pruning',120,20,0.00001) RETURNING id AS usage \gset

-- Preflight does not change state or coverage and discloses excluded classes honestly.
SELECT row_to_json(c)::text AS before_coverage FROM public.erasure_org_coverage c WHERE org_id=:'org' \gset
SELECT row_to_json(s)::text AS before_state FROM public.session_erasure_state s WHERE session_id=:'target' \gset
SELECT public.inspect_managed_session_erasure(:'org',:'target')::text AS inspection \gset
SELECT pg_temp.assert_erasure(:'inspection'::jsonb->>'status'='ready'
  AND :'inspection'::jsonb->'reasons'='[]'::jsonb
  AND :'inspection'::jsonb->'inventory'->'counts'->>'billing_records'='1'
  AND :'inspection'::jsonb->'inventory'->>'graph_ownership'='shared'
  AND :'inspection'::jsonb->'inventory'->>'backups'='not_inventoried'
  AND :'inspection'::jsonb->'classifications'->>'backups'='excluded'
  AND (SELECT row_to_json(c)::jsonb=:'before_coverage'::jsonb FROM public.erasure_org_coverage c WHERE org_id=:'org')
  AND (SELECT row_to_json(s)::jsonb=:'before_state'::jsonb FROM public.session_erasure_state s WHERE session_id=:'target'),
  'preflight did not report factual ready state or changed authority');
SELECT pg_temp.assert_erasure(public.inspect_managed_session_erasure(:'foreign_org',:'target') IS NULL
  AND public.prepare_session_erasure(:'foreign_org',:'target') IS NULL,
  'foreign scope disclosed or prepared target');
SELECT pg_temp.expect_erasure_error(format('SELECT public.execute_session_erasure(%L,%L)',:'org',:'target'),'55000');

-- These unsupported dependencies are refused before a fence or content mutation.
SAVEPOINT retained_fact_vector;
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',:'target','fact',:'survivor_fact',:'embedding'::vector);
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported'
  AND (SELECT state='active' FROM public.session_erasure_state WHERE session_id=:'target'),
  'target vector of retained fact did not block before prepare');
ROLLBACK TO retained_fact_vector;
RELEASE SAVEPOINT retained_fact_vector;
SAVEPOINT shared_target_origin;
INSERT INTO public.knowledge_entity_sessions(org_id,entity_id,session_id) VALUES(:'org',:'private_file',:'survivor');
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'shared_origin_unsupported',
  'shared target origin did not block');
ROLLBACK TO shared_target_origin;
RELEASE SAVEPOINT shared_target_origin;
SAVEPOINT retained_entity_vector;
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
VALUES(:'org',:'target','entity',:'shared_fn',:'embedding'::vector);
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported',
  'target vector of retained entity did not block');
ROLLBACK TO retained_entity_vector;
RELEASE SAVEPOINT retained_entity_vector;
SAVEPOINT incoming_decision;
INSERT INTO public.tech_decisions(org_id,session_id,confidence,decision_text,domain,project_scope,created_at)
VALUES(:'org',:'survivor',1,'outside successor','other.ts','orion','2026-03-01') RETURNING id AS outside_decision \gset
SELECT public.review_tech_decision_supersession(:'org','orion',:'outside_decision',:'td_new','fixture operator','outside reviewed dependency fixture');
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported',
  'outside reviewed decision did not block');
ROLLBACK TO incoming_decision;
RELEASE SAVEPOINT incoming_decision;
SAVEPOINT incoming_source;
INSERT INTO public.function_changes(org_id,session_id,confidence,old_name,change_type,file_path,project_scope)
VALUES(:'org',:'survivor',1,'outside source fact','deprecated','private.ts','orion');
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported',
  'exclusive File with surviving source fact did not block');
ROLLBACK TO incoming_source;
RELEASE SAVEPOINT incoming_source;
SAVEPOINT incoming_edge;
SELECT public.write_managed_graph_edge(:'org',:'survivor',jsonb_build_object(
  'from_entity',:'private_fn','to_entity',:'shared_fn','edge_type','REFERENCED_IN','project_scope','orion','scope_verified',true));
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported',
  'outside incident edge did not block');
ROLLBACK TO incoming_edge;
RELEASE SAVEPOINT incoming_edge;
SAVEPOINT duplicate_generic_identity;
INSERT INTO public.organizations(name) VALUES('Erasure unknown duplicate UUID fixture') RETURNING id AS duplicate_org \gset
INSERT INTO public.sessions(org_id,model) VALUES(:'duplicate_org','duplicate') RETURNING id AS duplicate_session \gset
INSERT INTO public.todos(id,org_id,session_id,confidence,description) VALUES(:'fc',:'duplicate_org',:'duplicate_session',1,'surviving legacy UUID collision');
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'ownership_inconsistent'
  AND (SELECT state='active' AND cardinality(erased_fact_ids)=0 FROM public.session_erasure_state WHERE session_id=:'target')
  AND EXISTS(SELECT 1 FROM public.todos WHERE id=:'fc' AND org_id=:'duplicate_org'),
  'generic identity collision deleted or fenced surviving fact');
ROLLBACK TO duplicate_generic_identity;
RELEASE SAVEPOINT duplicate_generic_identity;
SAVEPOINT incoming_pruning;
INSERT INTO public.billing_records(org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token)
VALUES(:'org',:'survivor',:'pruning',30,5,0.00001);
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'incoming_reference_unsupported',
  'outside usage referencing private pruning did not block');
ROLLBACK TO incoming_pruning;
RELEASE SAVEPOINT incoming_pruning;
SAVEPOINT unknown_class;
RESET ROLE;
CREATE TABLE public.erasure_fixture_unclassified(id uuid);
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'unknown_database_class',
  'unknown public table did not block');
ROLLBACK TO unknown_class;
RELEASE SAVEPOINT unknown_class;
SET LOCAL ROLE service_role;
SAVEPOINT unknown_materialized_class;
RESET ROLE;
CREATE MATERIALIZED VIEW public.erasure_fixture_materialized AS SELECT id,description FROM public.todos WHERE org_id=:'org';
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')->'reasons' ? 'unknown_database_class',
  'unclassified persisted materialized view did not block');
ROLLBACK TO unknown_materialized_class;
RELEASE SAVEPOINT unknown_materialized_class;
SET LOCAL ROLE service_role;

SELECT public.prepare_session_erasure(:'org',:'target')::text AS prepared \gset
SELECT pg_temp.assert_erasure(:'prepared'::jsonb->>'status'='prepared'
  AND public.prepare_session_erasure(:'org',:'target')=:'prepared'::jsonb
  AND (SELECT state='erasing' AND request_id=(:'prepared'::jsonb->>'request_id')::uuid FROM public.session_erasure_state WHERE session_id=:'target')
  AND public.inspect_session_erasure(:'org',:'target')->'counts'=:'inspection'::jsonb->'inventory'->'counts',
  'prepare did not preserve private content and stable scoped fence');
SELECT pg_temp.expect_erasure_error(format('SELECT public.mark_erasure_coverage_unknown(%L,%L)',:'org','protected_read'),'55000');
SELECT pg_temp.expect_erasure_error(format('INSERT INTO public.todos(org_id,session_id,confidence,description,project_scope) VALUES(%L,%L,1,%L,%L)',
  :'org',:'target','late task','orion'),'55000');

-- A real intermediate deletion failure must roll back all earlier deletes.
RESET ROLE;
CREATE FUNCTION pg_temp.fail_erasure_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'fixture intermediate usage deletion failure';
END; $$;
CREATE TRIGGER test_erasure_usage_failure BEFORE DELETE ON public.billing_records
FOR EACH ROW WHEN(OLD.id=:'usage'::uuid) EXECUTE FUNCTION pg_temp.fail_erasure_usage();
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_erasure_error(format('SELECT public.execute_session_erasure(%L,%L)',:'org',:'target'),'P0001');
SELECT pg_temp.assert_erasure(public.inspect_session_erasure(:'org',:'target')->'counts'=:'inspection'::jsonb->'inventory'->'counts'
  AND (SELECT state='erasing' AND receipt IS NULL AND request_id=(:'prepared'::jsonb->>'request_id')::uuid FROM public.session_erasure_state WHERE session_id=:'target')
  AND EXISTS(SELECT 1 FROM public.tech_decisions WHERE id=:'td_new' AND supersedes_id=:'td_old'),
  'intermediate failure lost content, reviewed evidence or retry fence');
RESET ROLE;
DROP TRIGGER test_erasure_usage_failure ON public.billing_records;
SET LOCAL ROLE service_role;
SELECT public.execute_session_erasure(:'org',:'target')::text AS receipt \gset
SELECT pg_temp.assert_erasure(:'receipt'::jsonb->>'status'='complete'
  AND :'receipt'::jsonb->>'org_id'=:'org' AND :'receipt'::jsonb->>'session_id'=:'target'
  AND :'receipt'::jsonb->>'request_id'=:'prepared'::jsonb->>'request_id'
  AND :'receipt'::jsonb->'deleted'='{"sessions":1,"billing_records":1,"pruning_logs":1,"function_changes":1,"tech_decisions":2,"policy_updates":1,"todos":1,"variable_changes":1,"operational_references":1,"audit_conflicts":2,"audit_statuses":1,"knowledge_entities":2,"knowledge_edges":1,"knowledge_entity_sessions":4,"knowledge_edge_sessions":2,"source_fact_links":3,"memory_vectors":3}'::jsonb
  AND :'receipt'::jsonb->'retained'='{"knowledge_entities":2,"knowledge_edges":1,"knowledge_entity_sessions":2,"knowledge_edge_sessions":1,"source_fact_links":1,"memory_vectors":1,"erasure_deployment":1,"erasure_org_coverage":1,"session_erasure_state":1,"erased_fact_ids":7,"erased_entity_ids":2}'::jsonb
  AND :'receipt'::jsonb->'exclusions'='["client_held_responses","privileged_host_database_snapshots","physical_heap_os_remnants"]'::jsonb,
  'complete receipt class counts, scope or exclusions incorrect');
SELECT pg_temp.assert_erasure(
  NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=:'target')
  AND NOT EXISTS(SELECT 1 FROM public.function_changes WHERE id=:'fc')
  AND NOT EXISTS(SELECT 1 FROM public.tech_decisions WHERE id IN(:'td_old',:'td_new'))
  AND NOT EXISTS(SELECT 1 FROM public.policy_updates WHERE id=:'pu')
  AND NOT EXISTS(SELECT 1 FROM public.todos WHERE id=:'todo')
  AND NOT EXISTS(SELECT 1 FROM public.variable_changes WHERE id=:'vc')
  AND NOT EXISTS(SELECT 1 FROM public.operational_references WHERE id=:'op')
  AND NOT EXISTS(SELECT 1 FROM public.audit_conflicts WHERE id IN(:'conflict_id',:'own_audit'))
  AND NOT EXISTS(SELECT 1 FROM public.audit_statuses WHERE fact_id=:'todo')
  AND NOT EXISTS(SELECT 1 FROM public.memory_vectors WHERE id IN(:'vector_fact',:'vector_other_pointer',:'vector_entity'))
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_entities WHERE id IN(:'private_file',:'private_fn'))
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=:'private_edge')
  AND NOT EXISTS(SELECT 1 FROM public.source_fact_links WHERE file_entity_id=:'private_file' OR function_change_id=:'fc' OR tech_decision_id IN(:'td_old',:'td_new'))
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_entity_sessions WHERE session_id=:'target')
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_edge_sessions WHERE session_id=:'target')
  AND NOT EXISTS(SELECT 1 FROM public.billing_records WHERE id=:'usage')
  AND NOT EXISTS(SELECT 1 FROM public.pruning_logs WHERE id=:'pruning'),
  'captured target identity survived deletion');
SELECT pg_temp.assert_erasure(
  (SELECT count(*)=2 AND bool_and(provenance_complete AND session_id=:'survivor') FROM public.knowledge_entities WHERE id IN(:'shared_file',:'shared_fn'))
  AND (SELECT provenance_complete AND session_id=:'survivor' FROM public.knowledge_edges WHERE id=:'shared_edge')
  AND (SELECT count(*)=2 FROM public.knowledge_entity_sessions WHERE entity_id IN(:'shared_file',:'shared_fn') AND session_id=:'survivor')
  AND EXISTS(SELECT 1 FROM public.knowledge_edge_sessions WHERE edge_id=:'shared_edge' AND session_id=:'survivor')
  AND EXISTS(SELECT 1 FROM public.memory_vectors WHERE id=:'vector_survivor')
  AND EXISTS(SELECT 1 FROM public.function_changes WHERE id=:'survivor_fact')
  AND EXISTS(SELECT 1 FROM public.source_fact_links WHERE file_entity_id=:'shared_file' AND function_change_id=:'survivor_fact')
  AND EXISTS(SELECT 1 FROM public.sessions WHERE id=:'foreign_session' AND org_id=:'foreign_org'),
  'shared or foreign survivor lost content/provenance');
SELECT pg_temp.assert_erasure(public.prepare_session_erasure(:'org',:'target')=:'receipt'::jsonb
  AND public.execute_session_erasure(:'org',:'target')=:'receipt'::jsonb
  AND public.prepare_session_erasure(:'foreign_org',:'target') IS NULL
  AND public.inspect_managed_session_erasure(:'org',:'target') IS NULL,
  'receipt retry changed content or leaked foreign/deleted target');
SELECT pg_temp.expect_erasure_error(format('INSERT INTO public.sessions(id,org_id,model) VALUES(%L,%L,%L)',:'target',:'org','resurrection'),'55000');
SELECT pg_temp.expect_erasure_error(format('INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,%L,%L,%L::vector)',
  :'foreign_org','fact',:'fc',:'embedding'),'55000');
RESET ROLE;
ROLLBACK;
SELECT pg_temp.assert_erasure(NOT EXISTS(SELECT 1 FROM public.organizations WHERE id IN(:'org',:'foreign_org',:'disabled_org'))
  AND NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=:'target')
  AND (SELECT NOT enabled FROM public.erasure_deployment WHERE id),
  'execution fixture failed to roll back data and activation');
SELECT 'Scoped SQL erasure: substantive deletion, shared survival, refusals, rollback, receipt and tombstones passed' AS result;
