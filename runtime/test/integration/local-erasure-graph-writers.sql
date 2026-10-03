-- specs/memory/session-erasure.md AC-B3/B8/B13: transaction-contained normal graph writes.
-- Isolated local instance only; all application data and privileged activation roll back.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.assert_graph_write(condition boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END;
$$;

CREATE FUNCTION pg_temp.expect_graph_write_error(statement text, expected_state text)
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
GRANT EXECUTE ON FUNCTION pg_temp.assert_graph_write(boolean,text),
  pg_temp.expect_graph_write_error(text,text) TO service_role;

BEGIN;
SET LOCAL statement_timeout = '10s';
SELECT pg_temp.assert_graph_write(
  to_regprocedure('public.write_managed_graph_entity(uuid,uuid,jsonb)') IS NOT NULL
  AND to_regprocedure('public.write_managed_graph_edge(uuid,uuid,jsonb)') IS NOT NULL,
  'AC-B13: managed graph writer RPCs are absent');

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.write_managed_graph_entity(uuid,uuid,jsonb)',
    'public.write_managed_graph_edge(uuid,uuid,jsonb)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = fn::regprocedure
      AND NOT prosecdef AND provolatile = 'v' AND proconfig @> ARRAY['search_path=""'])
      OR has_function_privilege('anon',fn,'EXECUTE')
      OR has_function_privilege('authenticated',fn,'EXECUTE')
      OR NOT has_function_privilege('service_role',fn,'EXECUTE') THEN
      RAISE EXCEPTION 'unsafe managed graph function privileges: %', fn;
    END IF;
  END LOOP;
END;
$$;

SET LOCAL ROLE service_role;
INSERT INTO public.organizations(name) VALUES ('C4B graph unknown fixture') RETURNING id AS legacy_org \gset
INSERT INTO public.sessions(org_id,model) VALUES (:'legacy_org','graph-legacy') RETURNING id AS legacy_session \gset
RESET ROLE;
-- Uncovered return must not depend on content SELECT privilege.
REVOKE SELECT ON public.knowledge_entities, public.knowledge_edges FROM service_role;
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_graph_write(
  public.write_managed_graph_entity(:'legacy_org',:'legacy_session','{"kind":"File","name":"a.ts","project_scope":null,"scope_verified":true}') IS NULL
  AND public.write_managed_graph_edge(:'legacy_org',:'legacy_session','{}') IS NULL,
  'unknown graph writer did not return literal NULL without content privileges');
RESET ROLE;
GRANT SELECT ON public.knowledge_entities, public.knowledge_edges TO service_role;

UPDATE public.erasure_deployment SET enabled=true, activation_id=gen_random_uuid(), activated_at=clock_timestamp(),
  source_manifest_sha256=repeat('a',64) WHERE id; -- Synthetic SQL unit digest; no artifact attestation.
SET LOCAL ROLE service_role;
SELECT id AS org FROM public.create_managed_organization('C4B graph managed fixture','growth') \gset
SELECT id AS target FROM public.create_project_session_if_under_cap(:'org','graph-target',3,NULL) \gset
SELECT id AS survivor FROM public.create_project_session_if_under_cap(:'org','graph-survivor',3,NULL) \gset
SELECT id AS foreign_org FROM public.create_managed_organization('C4B graph foreign fixture','growth') \gset
SELECT id AS foreign_session FROM public.create_session_if_under_cap(:'foreign_org','graph-foreign',2) \gset

SELECT public.write_managed_graph_entity(:'org',:'survivor',
  '{"kind":"File","name":"shared.ts","project_scope":null,"scope_verified":true,"file_path":"shared.ts","summary":"shared source"}') AS shared \gset
SELECT pg_temp.assert_graph_write(public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"File","name":"shared.ts","project_scope":null,"scope_verified":true,"file_path":"shared.ts","summary":"shared source"}') = :'shared'::uuid,
  'normal reuse did not preserve shared entity identity');
SELECT public.write_managed_graph_entity(:'org',:'survivor',
  '{"kind":"Function","name":"shared_function","project_scope":null,"scope_verified":true}') AS other \gset
SELECT public.write_managed_graph_edge(:'org',:'survivor',jsonb_build_object(
  'from_entity',:'shared','to_entity',:'other','edge_type','DECLARES','project_scope',NULL,'scope_verified',true)) AS edge \gset
SELECT pg_temp.assert_graph_write(public.write_managed_graph_edge(:'org',:'target',jsonb_build_object(
  'from_entity',:'shared','to_entity',:'other','edge_type','DECLARES','project_scope',NULL,'scope_verified',true)) = :'edge'::uuid,
  'normal reuse did not preserve shared edge identity');
SELECT pg_temp.assert_graph_write(
  (SELECT count(*)=1 AND bool_and(session_id=:'survivor'::uuid AND provenance_complete AND scope_verified)
    FROM public.knowledge_entities WHERE org_id=:'org' AND id=:'shared')
  AND (SELECT count(*)=1 AND bool_and(session_id=:'survivor'::uuid AND provenance_complete AND scope_verified)
    FROM public.knowledge_edges WHERE org_id=:'org' AND id=:'edge')
  AND (SELECT count(*)=2 FROM public.knowledge_entity_sessions WHERE org_id=:'org' AND entity_id=:'shared')
  AND (SELECT count(*)=2 FROM public.knowledge_edge_sessions WHERE org_id=:'org' AND edge_id=:'edge')
  AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=:'org'),
  'covered shared writer lost provenance, duplicated content or invalidated coverage');

-- Foreign/missing session metadata cannot authorize a protected graph query.
SELECT pg_temp.assert_graph_write(public.write_managed_graph_entity(:'org',:'foreign_session',
  '{"kind":"File","name":"foreign.ts","project_scope":null,"scope_verified":true}') IS NULL,
  'foreign session authorized graph creation');
SELECT pg_temp.expect_graph_write_error(format(
  'SELECT public.write_managed_graph_entity(%L,%L,%L::jsonb)', :'org',:'target',
  '{"kind":"File","name":"wrong.ts","project_scope":"orion","scope_verified":true}'), '22023');
SELECT pg_temp.expect_graph_write_error(format(
  'SELECT public.write_managed_graph_entity(%L,%L,%L::jsonb)', :'org',:'target',
  '{"kind":"File","name":"wrong.ts","project_scope":null,"scope_verified":true,"coverage":"covered"}'), '22023');
SELECT pg_temp.assert_graph_write(
  NOT EXISTS (SELECT 1 FROM public.knowledge_entities WHERE org_id=:'org' AND name IN ('foreign.ts','wrong.ts')),
  'rejected graph write left content');

-- Existing provenance update guard must still downgrade changed metadata.
SELECT pg_temp.assert_graph_write(public.write_managed_graph_entity(:'org',:'survivor',
  '{"kind":"File","name":"shared.ts","project_scope":null,"scope_verified":true,"summary":"changed source"}') = :'shared'::uuid,
  'managed metadata patch lost identity');
SELECT pg_temp.assert_graph_write(
  (SELECT summary='changed source' AND NOT provenance_complete AND session_id=:'survivor'::uuid
    FROM public.knowledge_entities WHERE id=:'shared')
  AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=:'org'),
  'metadata update upgraded or silently lost provenance');
SELECT pg_temp.assert_graph_write(public.write_managed_graph_entity(:'org',:'target',
  '{"kind":"File","name":"shared.ts","project_scope":null,"scope_verified":true}') IS NULL,
  'later managed writer cleared uncertainty');

RESET ROLE;
ROLLBACK;
SELECT pg_temp.assert_graph_write(
  NOT EXISTS (SELECT 1 FROM public.organizations WHERE id IN (:'org',:'foreign_org',:'legacy_org'))
  AND NOT EXISTS (SELECT 1 FROM public.erasure_org_coverage WHERE org_id IN (:'org',:'foreign_org',:'legacy_org'))
  AND (SELECT NOT enabled FROM public.erasure_deployment WHERE id),
  'graph writer fixture did not roll back its data/activation');
SELECT 'Managed graph writes: normal shared provenance, metadata-only refusal, copy uncertainty and rollback passed' AS result;
