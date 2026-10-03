-- specs/memory/session-erasure.md REQ-14 / AC-B12: negative restore admission.
-- Parent-owned isolated database only. All fixture state rolls back. Synthetic
-- retired identities below test refusal, not actual erasure or API completion.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_restore(condition boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END;
$$;
CREATE FUNCTION pg_temp.expect_restore_error(statement text, expected_state text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state IS DISTINCT FROM expected_state THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected restore rejection with SQLSTATE %', expected_state;
END;
$$;
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
    (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()));
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_restore(boolean,text),
  pg_temp.expect_restore_error(text,text) TO service_role;

BEGIN;
SET LOCAL statement_timeout = '10s';
SELECT pg_temp.assert_restore(
  to_regprocedure('public.prepare_erasure_restore(uuid,uuid[],uuid[],uuid[])') IS NOT NULL,
  'AC-B12: missing restore admission RPC');
DO $$
DECLARE signature text := 'public.prepare_erasure_restore(uuid,uuid[],uuid[],uuid[])';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = signature::regprocedure
      AND p.proowner = 'devops_erasure_executor'::regrole AND p.prosecdef
      AND p.provolatile = 'v' AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
    OR has_function_privilege('anon', signature, 'EXECUTE')
    OR has_function_privilege('authenticated', signature, 'EXECUTE')
    OR has_function_privilege('authenticator', signature, 'EXECUTE')
    OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'AC-B12: unsafe restore RPC ownership, search_path or ACL';
  END IF;
END;
$$;
SELECT gen_random_uuid() AS imported_org, gen_random_uuid() AS rejected_org,
  gen_random_uuid() AS existing_org, gen_random_uuid() AS foreign_org,
  gen_random_uuid() AS active_session, gen_random_uuid() AS erasing_session,
  gen_random_uuid() AS complete_session, gen_random_uuid() AS erased_fact,
  gen_random_uuid() AS erased_entity, gen_random_uuid() AS activation \gset

SET LOCAL ROLE service_role;
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(NULL,%L::uuid[],%L::uuid[],%L::uuid[])', '{}','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,NULL,%L::uuid[],%L::uuid[])', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],NULL,%L::uuid[])', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],NULL)', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,ARRAY[NULL]::uuid[],%L::uuid[],%L::uuid[])', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],ARRAY[NULL]::uuid[],%L::uuid[])', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],ARRAY[NULL]::uuid[])', :'rejected_org','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,ARRAY[ARRAY[%L::uuid]],%L::uuid[],%L::uuid[])', :'rejected_org',:'active_session','{}','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],ARRAY[ARRAY[%L::uuid]],%L::uuid[])', :'rejected_org','{}',:'erased_fact','{}'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],ARRAY[ARRAY[%L::uuid]])', :'rejected_org','{}','{}',:'erased_entity'), '22023');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],%L::uuid[])', :'rejected_org','{not-a-uuid}','{}','{}'), '22P02');
SELECT pg_temp.assert_restore(
  NOT EXISTS (SELECT 1 FROM public.erasure_org_coverage WHERE org_id = :'rejected_org'),
  'malformed admission left coverage metadata');

INSERT INTO public.organizations(id,name) VALUES (:'existing_org','C4B restore collision fixture');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],%L::uuid[])', :'existing_org','{}','{}','{}'), '55000');
SELECT pg_temp.assert_restore(
  NOT EXISTS (SELECT 1 FROM public.erasure_org_coverage WHERE org_id = :'existing_org'),
  'existing-org rejection silently marked or enrolled the target');

-- Test-only negative history; no live session or erased-content claim is made.
RESET ROLE;
INSERT INTO public.erasure_org_coverage(org_id,unknown_at,unknown_reason)
  VALUES (:'foreign_org',clock_timestamp(),'legacy_org');
INSERT INTO public.session_erasure_state(org_id,session_id,activation_id)
  VALUES (:'foreign_org',:'active_session',:'activation');
INSERT INTO public.session_erasure_state(org_id,session_id,activation_id,state,request_id,prepared_at)
  VALUES (:'foreign_org',:'erasing_session',:'activation','erasing',gen_random_uuid(),clock_timestamp());
INSERT INTO public.session_erasure_state(org_id,session_id,activation_id,state,request_id,prepared_at,completed_at,receipt,erased_fact_ids,erased_entity_ids)
  VALUES (:'foreign_org',:'complete_session',:'activation','complete',gen_random_uuid(),clock_timestamp(),clock_timestamp(),
    '{"fixture":"negative admission only"}'::jsonb,ARRAY[:'erased_fact'::uuid],ARRAY[:'erased_entity'::uuid]);
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,ARRAY[%L::uuid],%L::uuid[],%L::uuid[])', :'rejected_org',:'active_session','{}','{}'), '55000');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,ARRAY[%L::uuid],%L::uuid[],%L::uuid[])', :'rejected_org',:'erasing_session','{}','{}'), '55000');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,ARRAY[%L::uuid],%L::uuid[],%L::uuid[])', :'rejected_org',:'complete_session','{}','{}'), '55000');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],ARRAY[%L::uuid],%L::uuid[])', :'rejected_org','{}',upper(replace(:'erased_fact','-','')),'{}'), '55000');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],ARRAY[%L::uuid])', :'rejected_org','{}','{}','{' || upper(:'erased_entity') || '}'), '55000');
SELECT pg_temp.expect_restore_error(format(
  'SELECT public.prepare_erasure_restore(%L,%L::uuid[],%L::uuid[],%L::uuid[])', :'foreign_org','{}','{}','{}'), '55000');
SELECT pg_temp.assert_restore(
  NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = :'rejected_org')
  AND NOT EXISTS (SELECT 1 FROM public.erasure_org_coverage WHERE org_id = :'rejected_org')
  AND (SELECT count(*) = 3 FROM public.session_erasure_state WHERE org_id = :'foreign_org'),
  'tombstone rejection inserted content or changed retained history');

SELECT pg_temp.assert_restore(public.prepare_erasure_restore(:'imported_org','{}','{}','{}') IS TRUE,
  'absent-org admission was not acknowledged');
SELECT pg_temp.assert_restore(
  NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = :'imported_org')
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE org_id = :'imported_org')
  AND (SELECT unknown_at IS NOT NULL AND unknown_reason = 'restore_import' AND activation_id IS NULL
    FROM public.erasure_org_coverage WHERE org_id = :'imported_org'),
  'admission inserted active content or created positive coverage');
SELECT unknown_at AS first_unknown FROM public.erasure_org_coverage WHERE org_id = :'imported_org' \gset
SELECT pg_temp.assert_restore(public.prepare_erasure_restore(:'imported_org','{}','{}','{}') IS TRUE,
  'repeat absent-org admission did not acknowledge');
SELECT pg_temp.assert_restore(
  (SELECT unknown_at = :'first_unknown'::timestamptz AND unknown_reason = 'restore_import'
    FROM public.erasure_org_coverage WHERE org_id = :'imported_org'),
  'repeat admission reset first uncertainty');

-- Missing coverage metadata in the backup does not change future enrollment.
INSERT INTO public.organizations(id,name) VALUES (:'imported_org','C4B imported unknown fixture');
SELECT id AS imported_session FROM public.create_session_if_under_cap(:'imported_org','restore-unknown',3) \gset
SELECT pg_temp.assert_restore(
  NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'imported_session'),
  'restored organization enrolled a newly created session');
RESET ROLE;
-- Preserve a prior uncertainty reason/activation, rather than rewriting history.
INSERT INTO public.erasure_org_coverage(org_id,activation_id,unknown_at,unknown_reason)
  VALUES (:'rejected_org',:'activation','2026-01-01T00:00:00Z','backup_export');
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_restore(public.prepare_erasure_restore(:'rejected_org','{}','{}','{}') IS TRUE,
  'old absent-org uncertainty was rejected');
SELECT pg_temp.assert_restore(
  (SELECT unknown_at = '2026-01-01T00:00:00Z' AND unknown_reason = 'backup_export' AND activation_id = :'activation'
    FROM public.erasure_org_coverage WHERE org_id = :'rejected_org'),
  'restore changed historical uncertainty or activation');
ROLLBACK;

BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_restore_error(
  'SELECT public.prepare_erasure_restore(gen_random_uuid(),NULL,NULL,NULL)', '0A000');
ROLLBACK;
\echo C4-B restore admission checks passed; all fixture state rolled back
