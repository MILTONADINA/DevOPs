-- Disposable graph provenance proof; rolls back all fixture rows.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.organizations(name) VALUES ('Graph provenance A') RETURNING id AS org_a \gset
INSERT INTO public.organizations(name) VALUES ('Graph provenance B') RETURNING id AS org_b \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_a'::uuid, 'local-check') RETURNING id AS session_a \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_a'::uuid, 'local-check') RETURNING id AS session_shared \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_b'::uuid, 'local-check') RETURNING id AS session_b \gset

INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, provenance_complete)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'Decision', 'provenance-first', true)
RETURNING id AS entity_a \gset
INSERT INTO public.knowledge_entities(org_id, session_id, kind, name, provenance_complete)
VALUES (:'org_a'::uuid, :'session_a'::uuid, 'Decision', 'provenance-second', true)
RETURNING id AS entity_b \gset
INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type, provenance_complete)
VALUES (:'org_a'::uuid, :'session_a'::uuid, :'entity_a'::uuid, :'entity_b'::uuid, 'SUPERSEDES', true)
RETURNING id AS edge_a \gset

SELECT set_config('devops_test.prov_org_a', :'org_a', true),
  set_config('devops_test.prov_entity_a', :'entity_a', true),
  set_config('devops_test.prov_session_b', :'session_b', true) \gset

SELECT 1 / CASE WHEN (SELECT count(*) FROM public.knowledge_entity_sessions
      WHERE org_id = :'org_a'::uuid AND session_id = :'session_a'::uuid) = 2
  AND (SELECT count(*) FROM public.knowledge_edge_sessions
      WHERE org_id = :'org_a'::uuid AND session_id = :'session_a'::uuid) = 1
  THEN 1 ELSE 0 END AS atomic_insert_links_passed;

SELECT public.inspect_session_erasure(:'org_a'::uuid, :'session_a'::uuid) AS exclusive_report \gset
SELECT 1 / CASE WHEN (:'exclusive_report'::jsonb->>'graph_ownership') = 'exclusive'
  AND (:'exclusive_report'::jsonb->'counts'->>'knowledge_entity_sessions')::integer = 2
  AND (:'exclusive_report'::jsonb->'counts'->>'knowledge_edge_sessions')::integer = 1
  THEN 1 ELSE 0 END AS exclusive_provenance_passed;

INSERT INTO public.knowledge_entity_sessions(org_id, entity_id, session_id)
VALUES (:'org_a'::uuid, :'entity_a'::uuid, :'session_shared'::uuid);
INSERT INTO public.knowledge_edge_sessions(org_id, edge_id, session_id)
VALUES (:'org_a'::uuid, :'edge_a'::uuid, :'session_shared'::uuid);

SELECT 1 / CASE WHEN (public.inspect_session_erasure(:'org_a'::uuid, :'session_a'::uuid)->>'graph_ownership') = 'shared'
  AND (public.inspect_session_erasure(:'org_a'::uuid, :'session_shared'::uuid)->>'graph_ownership') = 'shared'
  THEN 1 ELSE 0 END AS shared_provenance_passed;

UPDATE public.knowledge_entities SET name = 'provenance-first-updated' WHERE id = :'entity_a'::uuid;
SELECT 1 / CASE WHEN (public.inspect_session_erasure(:'org_a'::uuid, :'session_a'::uuid)->>'graph_ownership') = 'ambiguous'
  THEN 1 ELSE 0 END AS legacy_uncertainty_passed;

DO $$
BEGIN
  BEGIN
    UPDATE public.knowledge_entities SET provenance_complete = true
      WHERE id = current_setting('devops_test.prov_entity_a')::uuid;
    RAISE EXCEPTION 'incomplete provenance was silently upgraded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'incomplete provenance was silently upgraded' THEN RAISE; END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.knowledge_entity_sessions(org_id, entity_id, session_id)
    VALUES (current_setting('devops_test.prov_org_a')::uuid,
      current_setting('devops_test.prov_entity_a')::uuid,
      current_setting('devops_test.prov_session_b')::uuid);
    RAISE EXCEPTION 'cross-organization provenance link unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
