-- specs/memory/session-erasure.md REQ-5/8/9/10, AC-B1/B2/B4/B9/B12.
-- Parent runs only on isolated c4b-erasure. All data and operator transitions
-- roll back. Synthetic SQL digests do NOT attest a real artifact/process/store.
-- This unit proves SQL authority/readiness preservation, not launcher or HTTP.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_generation(condition boolean,message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%',message; END IF;
END; $$;
CREATE FUNCTION pg_temp.expect_generation_error(statement text,expected_state text) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE actual_state text; BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state IS DISTINCT FROM expected_state THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected generation refusal with SQLSTATE %',expected_state;
END; $$;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role,devops_erasure_executor',
    (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
END; $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_generation(boolean,text),
  pg_temp.expect_generation_error(text,text) TO service_role,devops_erasure_executor;

BEGIN;
SET LOCAL statement_timeout='15s';
-- Expected pre-600 red stops here, before public inserts or activation.
SELECT pg_temp.assert_generation(EXISTS(
  SELECT 1 FROM pg_attribute WHERE attrelid='public.erasure_deployment'::regclass
    AND attname='source_manifest_sha256' AND NOT attisdropped),
  'AC-B1/B4: source manifest binding column is absent');
SELECT pg_temp.assert_generation(EXISTS(
  SELECT 1 FROM pg_attribute WHERE attrelid='public.erasure_deployment'::regclass
    AND attname='source_manifest_sha256' AND atttypid='text'::regtype
    AND NOT attnotnull AND NOT atthasdef),
  'generation digest must be nullable text without a fabricated default');
SELECT pg_temp.assert_generation((SELECT count(*)=1 AND bool_and(NOT enabled)
    AND bool_and(source_manifest_sha256 IS NULL)
    AND bool_and(source_generation='managed_explicit_session_v1') FROM public.erasure_deployment),
  'fresh append600 migration must retain a disabled, unbound deployment');
SELECT row_to_json(d)::text AS original_deployment FROM public.erasure_deployment d WHERE id \gset

-- Both malformed disabled metadata and enabled NULL are constraint failures.
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),activated_at=clock_timestamp(),source_manifest_sha256=NULL WHERE id','23514');
DO $$ DECLARE invalid_digest text; BEGIN
  FOREACH invalid_digest IN ARRAY ARRAY['',repeat('a',63),repeat('a',65),
    repeat('A',64),repeat('g',64),' '||repeat('a',64),repeat('a',64)||E'\n'] LOOP
    PERFORM pg_temp.expect_generation_error(format(
      'UPDATE public.erasure_deployment SET source_manifest_sha256=%L WHERE id',invalid_digest),'23514');
    PERFORM pg_temp.expect_generation_error(format(
      'UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),activated_at=clock_timestamp(),source_manifest_sha256=%L WHERE id',invalid_digest),'23514');
  END LOOP;
END; $$;
SELECT pg_temp.assert_generation((SELECT row_to_json(d)::jsonb=:'original_deployment'::jsonb
  FROM public.erasure_deployment d WHERE id),'failed activation changed deployment metadata');

-- Old table SELECT extends to the new column; ordinary writes do not.
DO $$ DECLARE role_name text; column_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','authenticator','service_role','devops_erasure_executor'] LOOP
    FOREACH column_name IN ARRAY ARRAY['source_manifest_sha256','enabled','activation_id','activated_at','source_generation'] LOOP
      IF has_column_privilege(role_name,'public.erasure_deployment',column_name,'INSERT')
        OR has_column_privilege(role_name,'public.erasure_deployment',column_name,'UPDATE')
        OR has_column_privilege(role_name,'public.erasure_deployment',column_name,'REFERENCES') THEN
        RAISE EXCEPTION 'generation authority leaked to % on %',role_name,column_name;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute a,LATERAL aclexplode(a.attacl) acl
      WHERE a.attrelid='public.erasure_deployment'::regclass AND a.attname='source_manifest_sha256'
        AND acl.grantee=0)
    OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.oid='public.erasure_deployment'::regclass AND acl.grantee=0)
    OR NOT has_column_privilege('service_role','public.erasure_deployment','source_manifest_sha256','SELECT')
    OR NOT has_column_privilege('devops_erasure_executor','public.erasure_deployment','id','UPDATE') THEN
    RAISE EXCEPTION 'generation ACL removed locking/read access or exposed public authority';
  END IF;
END; $$;
SET LOCAL ROLE devops_erasure_executor;
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET source_manifest_sha256=repeat(''a'',64) WHERE id','42501');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET source_manifest_sha256=repeat(''a'',64) WHERE id','42501');
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET enabled=true,source_manifest_sha256=repeat(''a'',64),activation_id=gen_random_uuid(),activated_at=clock_timestamp() WHERE id','42501');
SELECT set_config('devops.erasure_ready','true',true),
  set_config('devops.source_manifest_sha256',repeat('a',64),true);
SELECT id AS disabled_org FROM public.create_managed_organization('Generation disabled fixture','growth') \gset
SELECT id AS disabled_session FROM public.create_session_if_under_cap(:'disabled_org','disabled',3) \gset
INSERT INTO public.billing_records(org_id,session_id,original_tokens,quarantined_tokens,api_price_per_token)
VALUES(:'disabled_org',:'disabled_session',120,20,0.00001);
SELECT public.inspect_managed_session_erasure(:'disabled_org',:'disabled_session')::text AS disabled_inspection \gset
SELECT pg_temp.assert_generation(:'disabled_inspection'::jsonb->>'status'='blocked'
  AND :'disabled_inspection'::jsonb->'reasons' ?& ARRAY['deployment_unverified','coverage_unknown','session_not_enrolled','stores_not_inventoried']
  AND :'disabled_inspection'::jsonb->'classifications'='{"scope":"managed_explicit_session_v1","deployment":"unknown","enrollment":"unknown","database":"unknown","in_memory":"unknown","external_copies":"unknown","backups":"unknown"}'::jsonb
  AND :'disabled_inspection'::jsonb->'inventory'->'counts'->>'billing_records'='1'
  AND NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id=:'disabled_session')
  AND NOT (SELECT enabled FROM public.erasure_deployment),
  'disabled/GUC-only generation claimed inventoried stores, enrolled, or lost numeric usage');
SELECT pg_temp.assert_generation(public.prepare_session_erasure(:'disabled_org',:'disabled_session')->'reasons' ? 'stores_not_inventoried',
  'prepare omitted unknown managed-store classification');
SELECT row_to_json(c)::text AS disabled_coverage FROM public.erasure_org_coverage c WHERE org_id=:'disabled_org' \gset

-- Privileged synthetic generation A is only a rollback SQL prerequisite.
RESET ROLE;
UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),
  activated_at=clock_timestamp(),source_manifest_sha256=repeat('a',64)
  WHERE id RETURNING activation_id AS first_activation \gset
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET source_manifest_sha256=repeat(''b'',64),activation_id=gen_random_uuid() WHERE id','42501');
SELECT pg_temp.expect_generation_error(
  'UPDATE public.erasure_deployment SET source_manifest_sha256=NULL WHERE id','42501');
SELECT id AS sticky_org FROM public.create_managed_organization('Generation sticky fixture','growth') \gset
SELECT id AS sticky_session FROM public.create_session_if_under_cap(:'sticky_org','sticky',3) \gset
SELECT public.inspect_managed_session_erasure(:'sticky_org',:'sticky_session')::text AS ready_inspection \gset
SELECT pg_temp.assert_generation(:'ready_inspection'::jsonb->>'status'='ready'
  AND :'ready_inspection'::jsonb->'reasons'='[]'::jsonb
  AND :'ready_inspection'::jsonb->'classifications'='{"scope":"managed_explicit_session_v1","deployment":"covered","enrollment":"covered","database":"covered","in_memory":"excluded","external_copies":"excluded","backups":"excluded"}'::jsonb,
  'bound, clean, enrolled generation lost factual ready classification');
-- Ordinary explicit insertion still provides no positive enrollment.
INSERT INTO public.sessions(org_id,model,kind) VALUES(:'sticky_org','unenrolled','explicit') RETURNING id AS unenrolled_session \gset
SELECT public.inspect_managed_session_erasure(:'sticky_org',:'unenrolled_session')::text AS unenrolled_inspection \gset
SELECT pg_temp.assert_generation(:'unenrolled_inspection'::jsonb->>'status'='blocked'
  AND :'unenrolled_inspection'::jsonb->'reasons' ?& ARRAY['session_not_enrolled','stores_not_inventoried']
  AND NOT (:'unenrolled_inspection'::jsonb->'reasons' ? 'deployment_unverified')
  AND :'unenrolled_inspection'::jsonb->'classifications'->>'deployment'='covered'
  AND :'unenrolled_inspection'::jsonb->'classifications'->>'in_memory'='unknown'
  AND :'unenrolled_inspection'::jsonb->'classifications'->>'external_copies'='unknown'
  AND :'unenrolled_inspection'::jsonb->'classifications'->>'backups'='unknown',
  'bound deployment treated unenrolled session stores as inventoried');
SELECT pg_temp.assert_generation(public.mark_erasure_coverage_unknown(:'sticky_org','backup_export'),
  'copy marker did not acknowledge durable uncertainty');
SELECT public.inspect_managed_session_erasure(:'sticky_org',:'sticky_session')::text AS unknown_inspection \gset
SELECT pg_temp.assert_generation(:'unknown_inspection'::jsonb->>'status'='blocked'
  AND :'unknown_inspection'::jsonb->'reasons' ?& ARRAY['coverage_unknown','stores_not_inventoried']
  AND NOT (:'unknown_inspection'::jsonb->'reasons' ?| ARRAY['deployment_unverified','session_not_enrolled'])
  AND :'unknown_inspection'::jsonb->'classifications'->>'in_memory'='unknown'
  AND :'unknown_inspection'::jsonb->'classifications'->>'external_copies'='unknown'
  AND :'unknown_inspection'::jsonb->'classifications'->>'backups'='unknown',
  'unknown copied organization retained invented managed-store coverage');
SELECT row_to_json(c)::text AS sticky_coverage FROM public.erasure_org_coverage c WHERE org_id=:'sticky_org' \gset

-- Create an actual nonempty fence and actual completed receipt through normal
-- constructors/writers/RPCs; no positive state or retired-array fixture inserts.
SELECT id AS fenced_org FROM public.create_managed_organization('Generation fence fixture','growth') \gset
SELECT id AS fenced_session FROM public.create_session_if_under_cap(:'fenced_org','fenced',3) \gset
INSERT INTO public.todos(org_id,session_id,confidence,description)
VALUES(:'fenced_org',:'fenced_session',1,'generation fence content') RETURNING id AS fenced_fact \gset
SELECT public.prepare_session_erasure(:'fenced_org',:'fenced_session')::text AS prepared \gset
SELECT pg_temp.assert_generation(:'prepared'::jsonb->>'status'='prepared','normal nonempty preparation did not fence');
SELECT row_to_json(s)::text AS fenced_state FROM public.session_erasure_state s WHERE session_id=:'fenced_session' \gset
SELECT row_to_json(t)::text AS fenced_content FROM public.todos t WHERE id=:'fenced_fact' \gset
SELECT id AS completed_org FROM public.create_managed_organization('Generation complete fixture','growth') \gset
SELECT id AS completed_session FROM public.create_session_if_under_cap(:'completed_org','complete',3) \gset
INSERT INTO public.todos(org_id,session_id,confidence,description)
VALUES(:'completed_org',:'completed_session',1,'generation retired fact') RETURNING id AS retired_fact \gset
SELECT public.write_managed_graph_entity(:'completed_org',:'completed_session',
  '{"kind":"Function","name":"generation_retired_fn","project_scope":null,"scope_verified":true}') AS retired_entity \gset
SELECT pg_temp.assert_generation(public.prepare_session_erasure(:'completed_org',:'completed_session')->>'status'='prepared',
  'completed fixture did not prepare normally');
SELECT public.execute_session_erasure(:'completed_org',:'completed_session')::text AS receipt \gset
SELECT pg_temp.assert_generation(:'receipt'::jsonb->>'status'='complete'
  AND :'receipt'::jsonb->'deleted'->>'sessions'='1'
  AND :'receipt'::jsonb->'deleted'->>'todos'='1'
  AND :'receipt'::jsonb->'deleted'->>'knowledge_entities'='1'
  AND (SELECT erased_fact_ids=ARRAY[:'retired_fact'::uuid] AND erased_entity_ids=ARRAY[:'retired_entity'::uuid]
    FROM public.session_erasure_state WHERE session_id=:'completed_session'),
  'completed generation fixture lacks actual deletion/typed retirement');
SELECT row_to_json(s)::text AS completed_state FROM public.session_erasure_state s WHERE session_id=:'completed_session' \gset

-- Disabling a generation cannot clear an existing fence or receipt.
-- This unit's enclosing rollback is not evidence of cross-connection durability.
RESET ROLE;
UPDATE public.erasure_deployment SET enabled=false,source_manifest_sha256=NULL WHERE id;
SET LOCAL ROLE service_role;
SELECT public.inspect_managed_session_erasure(:'fenced_org',:'fenced_session')::text AS paused_inspection \gset
SELECT pg_temp.assert_generation(:'paused_inspection'::jsonb->>'status'='blocked'
  AND :'paused_inspection'::jsonb->'reasons' ?& ARRAY['deployment_unverified','stores_not_inventoried']
  AND NOT (:'paused_inspection'::jsonb->'reasons' ?| ARRAY['coverage_unknown','session_not_enrolled'])
  AND public.prepare_session_erasure(:'completed_org',:'completed_session')=:'receipt'::jsonb
  AND public.execute_session_erasure(:'completed_org',:'completed_session')=:'receipt'::jsonb,
  'disable erased receipt retry or omitted unknown store reasons');
SELECT pg_temp.expect_generation_error(format('SELECT public.execute_session_erasure(%L,%L)',:'fenced_org',:'fenced_session'),'55000');

-- Privileged synthetic generation B must leave prior authority/history intact.
RESET ROLE;
UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),
  activated_at=clock_timestamp(),source_manifest_sha256=repeat('b',64)
  WHERE id RETURNING activation_id AS second_activation \gset
SET LOCAL ROLE service_role;
SELECT public.inspect_managed_session_erasure(:'fenced_org',:'fenced_session')::text AS stale_inspection \gset
SELECT pg_temp.assert_generation(:'first_activation'<>:'second_activation'
  AND :'stale_inspection'::jsonb->>'status'='blocked'
  AND :'stale_inspection'::jsonb->'reasons' ?& ARRAY['coverage_unknown','session_not_enrolled','stores_not_inventoried']
  AND NOT (:'stale_inspection'::jsonb->'reasons' ? 'deployment_unverified')
  AND :'stale_inspection'::jsonb->'classifications'->>'deployment'='covered'
  AND :'stale_inspection'::jsonb->'classifications'->>'in_memory'='unknown'
  AND :'stale_inspection'::jsonb->'classifications'->>'external_copies'='unknown'
  AND :'stale_inspection'::jsonb->'classifications'->>'backups'='unknown'
  AND public.prepare_session_erasure(:'fenced_org',:'fenced_session')->'reasons' ? 'stores_not_inventoried',
  'new generation revived an old fence or claimed inventoried old stores');
SELECT pg_temp.expect_generation_error(format('SELECT public.execute_session_erasure(%L,%L)',:'fenced_org',:'fenced_session'),'55000');
SELECT pg_temp.expect_generation_error(format('SELECT public.mark_erasure_coverage_unknown(%L,%L)',:'fenced_org','protected_read'),'55000');
SELECT pg_temp.assert_generation((SELECT row_to_json(s)::jsonb=:'fenced_state'::jsonb FROM public.session_erasure_state s WHERE session_id=:'fenced_session')
  AND (SELECT row_to_json(t)::jsonb=:'fenced_content'::jsonb FROM public.todos t WHERE id=:'fenced_fact')
  AND (SELECT row_to_json(s)::jsonb=:'completed_state'::jsonb FROM public.session_erasure_state s WHERE session_id=:'completed_session')
  AND (SELECT row_to_json(c)::jsonb=:'disabled_coverage'::jsonb FROM public.erasure_org_coverage c WHERE org_id=:'disabled_org')
  AND (SELECT row_to_json(c)::jsonb=:'sticky_coverage'::jsonb FROM public.erasure_org_coverage c WHERE org_id=:'sticky_org'),
  'generation change or failed stale execution changed fence/content/receipt/uncertainty');
SELECT id AS sticky_later FROM public.create_session_if_under_cap(:'sticky_org','later-copy',4) \gset
SELECT id AS disabled_later FROM public.create_session_if_under_cap(:'disabled_org','later-disabled',3) \gset
SELECT pg_temp.assert_generation(NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE session_id IN(:'sticky_later',:'disabled_later'))
  AND (SELECT row_to_json(c)::jsonb=:'sticky_coverage'::jsonb FROM public.erasure_org_coverage c WHERE org_id=:'sticky_org')
  AND (SELECT row_to_json(c)::jsonb=:'disabled_coverage'::jsonb FROM public.erasure_org_coverage c WHERE org_id=:'disabled_org'),
  'reactivation or later capped creation upgraded permanently unknown organizations');
SELECT pg_temp.assert_generation(public.mark_erasure_coverage_unknown(:'completed_org','backup_export'),
  'completed organization did not retain ordinary negative copy marking');
SELECT id AS later_session FROM public.create_session_if_under_cap(:'completed_org','retired-retry',3) \gset
SELECT pg_temp.expect_generation_error(format(
  'INSERT INTO public.todos(id,org_id,session_id,confidence,description) VALUES(%L,%L,%L,1,%L)',
  :'retired_fact',:'completed_org',:'later_session','retired fact retry'),'55000');
SELECT pg_temp.expect_generation_error(format(
  'INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES(%L,%L,%L,%L,%L)',
  :'retired_entity',:'completed_org',:'later_session','Function','retired entity retry'),'55000');
SELECT pg_temp.expect_generation_error(format(
  'INSERT INTO public.sessions(id,org_id,model) VALUES(%L,%L,%L)',
  :'completed_session',:'completed_org','retired session retry'),'55000');
SELECT pg_temp.assert_generation(public.prepare_session_erasure(:'completed_org',:'completed_session')=:'receipt'::jsonb
  AND public.execute_session_erasure(:'completed_org',:'completed_session')=:'receipt'::jsonb
  AND (SELECT row_to_json(s)::jsonb=:'completed_state'::jsonb FROM public.session_erasure_state s WHERE session_id=:'completed_session'),
  'unknown/new generation changed completed receipt or typed retirement');

ROLLBACK;
SELECT pg_temp.assert_generation((SELECT row_to_json(d)::jsonb=:'original_deployment'::jsonb FROM public.erasure_deployment d WHERE id)
  AND NOT EXISTS(SELECT 1 FROM public.organizations WHERE id IN(:'disabled_org',:'sticky_org',:'fenced_org',:'completed_org'))
  AND NOT EXISTS(SELECT 1 FROM public.erasure_org_coverage WHERE org_id IN(:'disabled_org',:'sticky_org',:'fenced_org',:'completed_org'))
  AND NOT EXISTS(SELECT 1 FROM public.session_erasure_state WHERE org_id IN(:'disabled_org',:'sticky_org',:'fenced_org',:'completed_org')),
  'generation unit retained activation, application fixtures or private authority');
