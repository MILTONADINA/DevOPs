-- specs/memory/session-erasure.md AC-B1/B2/B3/B5/B6/B12: authority foundation.
-- Run only through the parent's isolated c4b-erasure database connection.
-- No executor/API acceptance is claimed here. All application fixtures and the
-- privileged activation below roll back; helper functions live only in pg_temp.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.assert_authority(condition boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END;
$$;

CREATE FUNCTION pg_temp.expect_authority_error(statement text, expected_state text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state IS DISTINCT FROM expected_state THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected authority rejection with SQLSTATE %', expected_state;
END;
$$;

-- SET ROLE below must not depend on the temporary schema's default ACL.
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
    (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()));
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_authority(boolean,text),
  pg_temp.expect_authority_error(text,text) TO service_role;

BEGIN;
SET LOCAL statement_timeout = '10s';
SELECT pg_temp.assert_authority(
  to_regclass('public.erasure_deployment') IS NOT NULL
  AND to_regclass('public.erasure_org_coverage') IS NOT NULL
  AND to_regclass('public.session_erasure_state') IS NOT NULL,
  'AC-B1: default-disabled erasure authority schema is absent');

SELECT pg_temp.assert_authority(
  (SELECT count(*) = 1 AND bool_and(NOT enabled)
    AND bool_and(length(source_generation) > 0)
    FROM public.erasure_deployment),
  'AC-B1: authority foundation must begin with exactly one disabled deployment');

-- Image defaults grant ordinary roles broad table rights. The new metadata must
-- explicitly revoke them, and content row guards need TRUNCATE/TRIGGER protection.
DO $$
DECLARE table_name text; role_name text; operation text; signature text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'erasure_deployment', 'erasure_org_coverage', 'session_erasure_state'
  ] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class
      WHERE oid = ('public.' || table_name)::regclass) THEN
      RAISE EXCEPTION 'AC-B1: metadata RLS missing on %', table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = ('public.' || table_name)::regclass AND a.grantee = 0) THEN
      RAISE EXCEPTION 'AC-B1: PUBLIC metadata grant remains on %', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      FOREACH operation IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
      ] LOOP
        IF has_table_privilege(role_name, 'public.' || table_name, operation) THEN
          RAISE EXCEPTION 'AC-B1: % has forbidden % on %', role_name, operation, table_name;
        END IF;
      END LOOP;
      IF has_any_column_privilege(role_name, 'public.' || table_name, 'INSERT')
        OR has_any_column_privilege(role_name, 'public.' || table_name, 'UPDATE') THEN
        RAISE EXCEPTION 'AC-B1: % has a metadata column-write grant on %', role_name, table_name;
      END IF;
      IF has_table_privilege(role_name, 'public.' || table_name, 'SELECT')
        IS DISTINCT FROM (role_name = 'service_role') THEN
        RAISE EXCEPTION 'AC-B1: metadata SELECT grant wrong for % on %', role_name, table_name;
      END IF;
    END LOOP;
  END LOOP;
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    IF EXISTS (SELECT 1 FROM pg_class c,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = ('public.' || table_name)::regclass AND a.grantee = 0
        AND a.privilege_type IN ('TRUNCATE', 'TRIGGER')) THEN
      RAISE EXCEPTION 'AC-B6: PUBLIC can bypass row guards on %', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(role_name, 'public.' || table_name, 'TRUNCATE')
        OR has_table_privilege(role_name, 'public.' || table_name, 'TRIGGER') THEN
        RAISE EXCEPTION 'AC-B6: % can bypass row guards on %', role_name, table_name;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devops_erasure_executor'
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole
    AND NOT rolcreatedb AND NOT rolreplication
    AND rolbypassrls) THEN
    RAISE EXCEPTION 'AC-B1: executor role authority differs from reviewed boundary';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'authenticator', 'service_role'] LOOP
    IF pg_has_role(role_name, 'devops_erasure_executor', 'SET')
      OR pg_has_role(role_name, 'devops_erasure_executor', 'USAGE') THEN
      RAISE EXCEPTION 'AC-B1: % can assume executor authority', role_name;
    END IF;
  END LOOP;
  IF has_column_privilege('devops_erasure_executor', 'public.erasure_deployment', 'enabled', 'UPDATE')
    OR has_column_privilege('devops_erasure_executor', 'public.erasure_deployment', 'activation_id', 'UPDATE')
    OR has_column_privilege('devops_erasure_executor', 'public.erasure_deployment', 'source_generation', 'UPDATE')
    OR has_schema_privilege('devops_erasure_executor', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'AC-B1: executor can activate coverage or create public objects';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'public.create_managed_organization(text,text)',
    'public.create_session_if_under_cap(uuid,text,integer)',
    'public.create_project_session_if_under_cap(uuid,text,integer,text)',
    'public.mark_erasure_coverage_unknown(uuid,text)'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'AC-B2: required authority RPC absent: %', signature;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = signature::regprocedure
        AND p.proowner = 'devops_erasure_executor'::regrole
        AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig @> ARRAY['search_path=""']::text[]
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
      OR has_function_privilege('anon', signature, 'EXECUTE')
      OR has_function_privilege('authenticated', signature, 'EXECUTE')
      OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'AC-B1: unsafe RPC ownership/search_path/ACL: %', signature;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('public.erasure_org_coverage'::regclass,
      'public.session_erasure_state'::regclass)
      AND contype = 'f' AND confrelid IN ('public.organizations'::regclass,
        'public.sessions'::regclass)) THEN
    RAISE EXCEPTION 'AC-B12: metadata lifetime depends on content/org rows';
  END IF;
END;
$$;
SELECT pg_temp.assert_authority(
  has_table_privilege('service_role', 'public.audit_statuses', 'DELETE'),
  'AC-B12: ordinary unknown-org audit cleanup grant was removed');

SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(
  'UPDATE public.erasure_deployment SET enabled = true', '42501');
SELECT pg_temp.expect_authority_error(
  'TRUNCATE public.session_erasure_state', '42501');
SELECT pg_temp.expect_authority_error(
  'ALTER TABLE public.sessions DISABLE TRIGGER ALL', '42501');
SELECT set_config('devops.erasure_ready', 'true', true),
  set_config('devops.erasure_activation', gen_random_uuid()::text, true);

SELECT id AS disabled_org FROM public.create_managed_organization(
  'C4B authority inactive fixture', 'growth') \gset
SELECT id AS disabled_session FROM public.create_session_if_under_cap(
  :'disabled_org', 'authority-inactive', 2) \gset
SELECT pg_temp.assert_authority(
  (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id = :'disabled_org')
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'disabled_session')
  AND NOT (SELECT enabled FROM public.erasure_deployment),
  'AC-B1/B2: inactive creation or writable GUC conferred coverage');

INSERT INTO public.organizations(name) VALUES ('C4B authority generic fixture')
  RETURNING id AS generic_org \gset
SELECT id AS generic_session FROM public.create_session_if_under_cap(
  :'generic_org', 'authority-generic', 2) \gset
SELECT pg_temp.assert_authority(
  NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'generic_session'),
  'AC-B2: generic organization enrolled');

-- Rollback-only operator setup. No service RPC/flag performs this transition.
RESET ROLE;
UPDATE public.erasure_deployment SET enabled = true,
  activation_id = gen_random_uuid(), activated_at = clock_timestamp(),
  source_manifest_sha256 = repeat('a',64) -- Synthetic SQL unit digest; no artifact attestation.
  WHERE id RETURNING activation_id AS first_activation \gset
SET LOCAL ROLE service_role;

SELECT id AS covered_org FROM public.create_managed_organization(
  'C4B authority fresh fixture', 'growth') \gset
SELECT id AS second_org FROM public.create_managed_organization(
  'C4B authority fresh fixture', 'growth') \gset
SELECT pg_temp.assert_authority(:'covered_org' <> :'second_org'
  AND (SELECT unknown_at IS NULL AND activation_id = :'first_activation'
    FROM public.erasure_org_coverage WHERE org_id = :'covered_org'),
  'AC-B2: constructor reused name/identity or omitted clean atomic coverage');
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.create_managed_organization(p_name => %L,p_plan => %L,p_org_id => %L::uuid)',
  'supplied identity denied', 'growth', :'generic_org'), '42883');

SELECT id AS target_session FROM public.create_session_if_under_cap(
  :'covered_org', 'authority-explicit', 2) \gset
SELECT id AS project_session FROM public.create_project_session_if_under_cap(
  :'covered_org', 'authority-project', 2, 'orion') \gset
SELECT pg_temp.assert_authority(
  (SELECT count(*) = 0 FROM public.create_session_if_under_cap(:'covered_org', 'over-cap', 2))
  AND (SELECT count(*) = 2 FROM public.sessions WHERE org_id = :'covered_org')
  AND (SELECT count(*) = 2 AND bool_and(state = 'active')
    AND bool_and(activation_id = :'first_activation')
    AND bool_and(request_id IS NULL AND receipt IS NULL)
    FROM public.session_erasure_state WHERE org_id = :'covered_org')
  AND (SELECT kind = 'explicit' AND project_scope = 'orion'
    FROM public.sessions WHERE id = :'project_session'),
  'AC-B2: cap/project/atomic enrollment contract changed');

INSERT INTO public.sessions(org_id, model, kind)
  VALUES (:'second_org', 'authority-direct', 'explicit'),
    (:'second_org', 'authority-usage', 'usage'),
    (:'second_org', 'authority-memory', 'memory');
INSERT INTO public.api_keys(org_id, key_hash, name)
  VALUES (:'second_org', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'authority fixture')
  RETURNING id AS fixture_key \gset
INSERT INTO public.sessions(org_id, model, kind, conversation_key_id)
  VALUES (:'second_org', 'authority-conversation', 'conversation', :'fixture_key');
SELECT pg_temp.assert_authority(
  NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE org_id = :'second_org'),
  'AC-B2: generic or internal session path enrolled');

SELECT id AS atomic_org FROM public.create_managed_organization(
  'C4B authority atomic failure fixture', 'growth') \gset
RESET ROLE;
CREATE FUNCTION pg_temp.fail_authority_enrollment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority fixture injected enrollment failure';
END;
$$;
CREATE TRIGGER test_authority_enrollment_failure
  BEFORE INSERT ON public.session_erasure_state FOR EACH ROW
  WHEN (NEW.org_id = :'atomic_org'::uuid)
  EXECUTE FUNCTION pg_temp.fail_authority_enrollment();
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.create_session_if_under_cap(%L,%L,2)',
  :'atomic_org', 'authority-enrollment-failure'), 'P0001');
SELECT pg_temp.assert_authority(
  NOT EXISTS (SELECT 1 FROM public.sessions WHERE org_id = :'atomic_org')
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE org_id = :'atomic_org'),
  'AC-B2: enrollment failure left a committed explicit session');
RESET ROLE;
DROP TRIGGER test_authority_enrollment_failure ON public.session_erasure_state;
SET LOCAL ROLE service_role;

-- Negative-only operator setup: prove copy refusal before a prepare RPC exists.
-- The savepoint restores the normally enrolled active state afterward.
SAVEPOINT authority_erasing_conflict;
RESET ROLE;
UPDATE public.session_erasure_state SET state = 'erasing',
  request_id = gen_random_uuid(), prepared_at = clock_timestamp()
  WHERE session_id = :'target_session';
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.mark_erasure_coverage_unknown(%L,%L)',
  :'covered_org', 'protected_read'), '55000');
SELECT pg_temp.assert_authority(
  (SELECT unknown_at IS NULL AND unknown_reason IS NULL
    FROM public.erasure_org_coverage WHERE org_id = :'covered_org')
  AND (SELECT state = 'erasing' FROM public.session_erasure_state
    WHERE session_id = :'target_session'),
  'AC-B3: refused protected copy changed coverage or removed the erasing fence');
ROLLBACK TO SAVEPOINT authority_erasing_conflict;
RELEASE SAVEPOINT authority_erasing_conflict;
SET LOCAL ROLE service_role;

SELECT pg_temp.assert_authority(
  public.mark_erasure_coverage_unknown(:'covered_org', 'protected_read') IS TRUE,
  'AC-B3: marker did not return a true committed-operation acknowledgement');
SELECT pg_temp.assert_authority(
  (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id = :'covered_org'),
  'AC-B3: marker acknowledged without durable uncertainty');
SELECT unknown_at::text AS first_unknown_at, unknown_reason AS first_unknown_reason
  FROM public.erasure_org_coverage WHERE org_id = :'covered_org' \gset
SELECT pg_temp.assert_authority(
  public.mark_erasure_coverage_unknown(:'covered_org', 'backup_export') IS TRUE,
  'AC-B3: already-unknown marker did not acknowledge');
SELECT id AS later_session FROM public.create_session_if_under_cap(
  :'covered_org', 'authority-after-copy', 10) \gset
SELECT pg_temp.assert_authority(
  (SELECT unknown_at = :'first_unknown_at'::timestamptz
    AND unknown_reason = :'first_unknown_reason'
    FROM public.erasure_org_coverage WHERE org_id = :'covered_org')
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'later_session'),
  'AC-B3: copy uncertainty reset or future session enrolled');
SELECT pg_temp.expect_authority_error(format(
  'UPDATE public.erasure_org_coverage SET unknown_at = NULL, unknown_reason = NULL WHERE org_id = %L',
  :'covered_org'), '42501');
SELECT pg_temp.expect_authority_error(format(
  'DELETE FROM public.erasure_org_coverage WHERE org_id = %L', :'covered_org'), '42501');
SELECT pg_temp.expect_authority_error(format(
  'UPDATE public.session_erasure_state SET state = %L WHERE session_id = %L',
  'complete', :'target_session'), '42501');

SELECT id AS stale_org FROM public.create_managed_organization(
  'C4B authority stale generation fixture', 'growth') \gset
SELECT id AS stale_session FROM public.create_session_if_under_cap(
  :'stale_org', 'authority-before-rebind', 2) \gset
RESET ROLE;
UPDATE public.erasure_deployment SET enabled = false WHERE id;
UPDATE public.erasure_deployment SET enabled = true,
  activation_id = gen_random_uuid(), activated_at = clock_timestamp(),
  source_manifest_sha256 = repeat('b',64) -- Synthetic second SQL unit generation.
  WHERE id RETURNING activation_id AS second_activation \gset
SET LOCAL ROLE service_role;
SELECT id AS stale_later_session FROM public.create_session_if_under_cap(
  :'stale_org', 'authority-after-rebind', 2) \gset
SELECT pg_temp.assert_authority(:'first_activation' <> :'second_activation'
  AND (SELECT activation_id = :'first_activation' FROM public.session_erasure_state
    WHERE session_id = :'stale_session')
  AND (SELECT activation_id = :'first_activation' FROM public.erasure_org_coverage
    WHERE org_id = :'stale_org')
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'stale_later_session'),
  'AC-B4: reactivation revived stale organization enrollment');

-- Negative authority fixture only: an operator seeds a completed marker for a
-- never-created UUID. This does not claim deletion or satisfy real API AC-B7/B9.
SELECT id AS tombstone_org FROM public.create_managed_organization(
  'C4B authority tombstone fixture', 'growth') \gset
SELECT gen_random_uuid() AS retired_session \gset
RESET ROLE;
INSERT INTO public.session_erasure_state(
  org_id, session_id, activation_id, state, enrolled_at, request_id,
  prepared_at, completed_at, receipt)
VALUES (:'tombstone_org', :'retired_session', :'second_activation', 'complete',
  now(), gen_random_uuid(), now(), now(), '{"status":"complete","fixture":"authority-only"}'::jsonb);
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(format(
  'INSERT INTO public.sessions(id,org_id,model) VALUES (%L,%L,%L)',
  :'retired_session', :'tombstone_org', 'authority-resurrection'), '55000');
SELECT pg_temp.expect_authority_error(format(
  'INSERT INTO public.sessions(id,org_id,model) VALUES (%L,%L,%L)',
  :'retired_session', :'second_org', 'authority-foreign-resurrection'), '55000');
DELETE FROM public.organizations WHERE id = :'tombstone_org';
SELECT pg_temp.assert_authority(
  EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'retired_session' AND state = 'complete')
  AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id = :'tombstone_org'),
  'AC-B12: organization removal lost tombstone/uncertainty authority');
INSERT INTO public.organizations(id, name) VALUES (:'tombstone_org', 'C4B generic recreated org');
SELECT id AS recreated_session FROM public.create_session_if_under_cap(
  :'tombstone_org', 'authority-recreated-org', 2) \gset
SELECT pg_temp.assert_authority(
  NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = :'recreated_session'),
  'AC-B12: reused organization UUID regained clean coverage');
SELECT pg_temp.expect_authority_error(format(
  'INSERT INTO public.sessions(id,org_id,model) VALUES (%L,%L,%L)',
  :'retired_session', :'tombstone_org', 'authority-recreated-resurrection'), '55000');

RESET ROLE;
ROLLBACK;

-- Isolation is rejected before ownership lookups, even for nonexistent identities
-- or a generic legacy path. The temporary assertion functions survive rollback.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(
  $$SELECT public.create_managed_organization('authority RR rejected','growth')$$, '0A000');
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.create_session_if_under_cap(%L,%L,2)', :'generic_org', 'authority RR rejected'), '0A000');
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.create_project_session_if_under_cap(%L,%L,2,%L)',
  :'generic_org', 'authority RR rejected', 'orion'), '0A000');
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.mark_erasure_coverage_unknown(%L,%L)', :'generic_org', 'protected_read'), '0A000');
SELECT pg_temp.expect_authority_error(format(
  'INSERT INTO public.sessions(org_id,model) VALUES (%L,%L)',
  :'generic_org', 'authority RR rejected'), '0A000');
ROLLBACK;

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.expect_authority_error(
  $$SELECT public.create_managed_organization('authority serializable rejected','growth')$$, '0A000');
SELECT pg_temp.expect_authority_error(format(
  'SELECT public.mark_erasure_coverage_unknown(%L,%L)', :'generic_org', 'protected_read'), '0A000');
ROLLBACK;

SELECT pg_temp.assert_authority(
  NOT EXISTS (SELECT 1 FROM public.organizations WHERE id IN (
    :'disabled_org', :'generic_org', :'covered_org', :'second_org', :'stale_org', :'tombstone_org', :'atomic_org'))
  AND NOT EXISTS (SELECT 1 FROM public.erasure_org_coverage WHERE org_id IN (
    :'disabled_org', :'generic_org', :'covered_org', :'second_org', :'stale_org', :'tombstone_org', :'atomic_org'))
  AND NOT EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id IN (
    :'target_session', :'project_session', :'stale_session', :'retired_session'))
  AND (SELECT count(*) = 1 AND bool_and(NOT enabled) FROM public.erasure_deployment),
  'authority fixture did not roll back all application data/activation');
SELECT 'C4-B authority foundation: privileges, normal enrollment, uncertainty, tombstones, isolation, rollback passed' AS result;
