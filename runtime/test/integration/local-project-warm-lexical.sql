-- Disposable proof of typed lexical recall, scope, suppression, and grants.
BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid(); foreign_org uuid := gen_random_uuid();
  session_orion uuid := gen_random_uuid(); session_vega uuid := gen_random_uuid();
  session_foreign uuid := gen_random_uuid(); old_decision uuid := gen_random_uuid();
  new_decision uuid := gen_random_uuid(); found_tables text[];
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org, 'lexical fixture'), (foreign_org, 'foreign lexical fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model) VALUES
    (session_orion, org, 'orion', 'fixture'),
    (session_vega, org, 'vega', 'fixture'),
    (session_foreign, foreign_org, 'orion', 'fixture');
  INSERT INTO public.function_changes(org_id, session_id, project_scope, confidence, old_name, change_type)
    VALUES (org, session_orion, 'orion', 0.9, 'lexicalneedle function', 'renamed');
  INSERT INTO public.tech_decisions(id, org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
    VALUES (old_decision, org, session_orion, 'orion', '2026-09-20', 0.9, 'old lexicalneedle route', 'runtime'),
           (new_decision, org, session_orion, 'orion', '2026-09-21', 0.9, 'new lexicalneedle route', 'runtime');
  PERFORM public.review_tech_decision_supersession(org, 'orion', new_decision, old_decision,
    'fixture operator', 'Reviewed newer route and replaced the old route.');
  INSERT INTO public.policy_updates(org_id, session_id, project_scope, confidence, policy_name, new_value, policy_type)
    VALUES (org, session_orion, 'orion', 0.9, 'lexicalneedle policy', 'enabled', 'process');
  INSERT INTO public.todos(org_id, session_id, project_scope, confidence, description)
    VALUES (org, session_orion, 'orion', 0.9, 'Check lexicalneedle todo');
  INSERT INTO public.variable_changes(org_id, session_id, project_scope, confidence, var_name, new_value)
    VALUES (org, session_orion, 'orion', 0.9, 'LEXICALNEEDLE', 'enabled');
  INSERT INTO public.tech_decisions(org_id, session_id, project_scope, confidence, decision_text, domain, is_suppressed)
    VALUES (org, session_orion, 'orion', 0.9, 'suppressed lexicalneedle', 'runtime', true),
           (org, session_vega, 'vega', 0.9, 'vega lexicalneedle', 'runtime', false),
           (foreign_org, session_foreign, 'orion', 0.9, 'foreign lexicalneedle', 'runtime', false);

  SELECT array_agg(fact_table ORDER BY fact_table) INTO found_tables
    FROM public.search_project_warm_facts(org, 'orion', 'lexicalneedle', 20);
  IF found_tables IS DISTINCT FROM ARRAY[
    'function_changes', 'policy_updates', 'tech_decisions', 'todos', 'variable_changes'
  ]::text[] THEN
    RAISE EXCEPTION 'typed lexical result crossed scope or omitted a table: %', found_tables;
  END IF;
  IF EXISTS (SELECT 1 FROM public.search_project_warm_facts(org, 'orion', 'lexicalneedle', 20)
    WHERE (fact->>'id')::uuid = old_decision) THEN
    RAISE EXCEPTION 'reviewed old decision appeared';
  END IF;
  IF (SELECT count(*) FROM public.search_project_warm_facts(org, 'orion', 'lexicalneedle', 2)) <> 2
    OR (SELECT count(*) FROM public.search_project_warm_facts(org, 'orion', 'lexicalneedle', 100)) <> 5
    OR EXISTS (SELECT 1 FROM public.search_project_warm_facts(foreign_org, 'vega', 'lexicalneedle', 20)) THEN
    RAISE EXCEPTION 'lexical bounds or exact binding failed';
  END IF;
  IF has_function_privilege('anon', 'public.search_project_warm_facts(uuid,text,text,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.search_project_warm_facts(uuid,text,text,integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.search_project_warm_facts(uuid,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'lexical RPC grants incorrect';
  END IF;
END;
$$;
ROLLBACK;
