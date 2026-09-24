-- Disposable exact-project supersession and grant fixture.
BEGIN;
DO $$
DECLARE
  org_id uuid := gen_random_uuid(); other_org uuid := gen_random_uuid();
  orion_session uuid := gen_random_uuid(); vega_session uuid := gen_random_uuid();
  unbound_session uuid := gen_random_uuid();
  orion_old uuid := gen_random_uuid(); orion_new uuid := gen_random_uuid();
  vega_old uuid := gen_random_uuid(); vega_new uuid := gen_random_uuid();
  unbound_old uuid := gen_random_uuid(); unbound_new uuid := gen_random_uuid();
  uncertain_old uuid := gen_random_uuid(); uncertain_new uuid := gen_random_uuid();
  incomplete_new uuid := gen_random_uuid(); unproven_new uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org_id, 'supersession fixture'), (other_org, 'foreign fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model) VALUES
    (orion_session, org_id, 'orion', 'fixture'),
    (vega_session, org_id, 'vega', 'fixture'),
    (unbound_session, org_id, NULL, 'fixture');
  INSERT INTO public.knowledge_entities(id, org_id, session_id, kind, name, project_scope, scope_verified, provenance_complete) VALUES
    (orion_old, org_id, orion_session, 'Decision', 'old', 'orion', true, true),
    (orion_new, org_id, orion_session, 'Decision', 'orion-new', 'orion', true, true),
    (vega_old, org_id, vega_session, 'Decision', 'old', 'vega', true, true),
    (vega_new, org_id, vega_session, 'Decision', 'vega-new', 'vega', true, true),
    (unbound_old, org_id, unbound_session, 'Decision', 'old', NULL, true, true),
    (unbound_new, org_id, unbound_session, 'Decision', 'unbound-new', NULL, true, true),
    (uncertain_old, org_id, unbound_session, 'Decision', 'uncertain-old', NULL, false, true),
    (uncertain_new, org_id, unbound_session, 'Decision', 'uncertain-new', NULL, false, true),
    (incomplete_new, org_id, orion_session, 'Decision', 'incomplete-new', 'orion', true, false),
    (unproven_new, org_id, orion_session, 'Decision', 'unproven-new', 'orion', true, true);
  INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type, project_scope, scope_verified, provenance_complete) VALUES
    (org_id, orion_session, orion_new, orion_old, 'SUPERSEDES', 'orion', true, true),
    (org_id, vega_session, vega_new, vega_old, 'SUPERSEDES', 'vega', true, true),
    (org_id, unbound_session, unbound_new, unbound_old, 'SUPERSEDES', NULL, true, true),
    (org_id, unbound_session, uncertain_new, uncertain_old, 'SUPERSEDES', NULL, false, true),
    (org_id, orion_session, incomplete_new, orion_old, 'SUPERSEDES', 'orion', true, true),
    (org_id, orion_session, unproven_new, orion_old, 'SUPERSEDES', 'orion', true, false);
  IF (SELECT array_agg(superseded_by ORDER BY superseded_by) FROM public.find_project_superseded(org_id, 'orion', ARRAY['old'])) IS DISTINCT FROM ARRAY['orion-new']::text[] THEN
    RAISE EXCEPTION 'Orion supersession was cross-project or incomplete';
  END IF;
  IF (SELECT array_agg(superseded_by) FROM public.find_project_superseded(org_id, 'vega', ARRAY['old'])) IS DISTINCT FROM ARRAY['vega-new']::text[] THEN
    RAISE EXCEPTION 'Vega supersession was cross-project';
  END IF;
  IF (SELECT array_agg(superseded_by) FROM public.find_project_superseded(org_id, NULL, ARRAY['old'])) IS DISTINCT FROM ARRAY['unbound-new']::text[] THEN
    RAISE EXCEPTION 'verified unbound supersession included another project';
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_project_superseded(org_id, NULL, ARRAY['uncertain-old']))
    OR EXISTS (SELECT 1 FROM public.find_project_superseded(org_id, 'orion', ARRAY['unknown']))
    OR EXISTS (SELECT 1 FROM public.find_project_superseded(other_org, 'orion', ARRAY['old'])) THEN
    RAISE EXCEPTION 'uncertain, unrelated, or foreign supersession leaked';
  END IF;
  IF has_function_privilege('anon', 'public.find_project_superseded(uuid,text,text[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_project_superseded(uuid,text,text[])', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_project_superseded(uuid,text,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'project supersession function grants are wrong';
  END IF;
END;
$$;
ROLLBACK;
