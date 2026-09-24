-- Disposable exact conversation/project/exchange lookup and service grant check.
BEGIN;
DO $$
DECLARE
  org_id uuid := gen_random_uuid(); other_org uuid := gen_random_uuid();
  orion_key uuid := gen_random_uuid(); vega_key uuid := gen_random_uuid();
  orion_session uuid := gen_random_uuid(); other_session uuid := gen_random_uuid();
  vega_session uuid := gen_random_uuid(); memory_session uuid := gen_random_uuid();
  old_exchange uuid := gen_random_uuid(); new_exchange uuid := gen_random_uuid();
  ambiguous_exchange uuid := gen_random_uuid(); suppressed_exchange uuid := gen_random_uuid();
  decision_old uuid := gen_random_uuid(); decision_new uuid := gen_random_uuid();
  function_old uuid := gen_random_uuid(); function_new uuid := gen_random_uuid();
  names text[];
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org_id, 'exchange fixture'), (other_org, 'foreign fixture');
  INSERT INTO public.api_keys(id, org_id, project_scope, key_hash, name) VALUES
    (orion_key, org_id, 'orion', repeat('a', 64), 'orion fixture'),
    (vega_key, org_id, 'vega', repeat('b', 64), 'vega fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model, kind, conversation_key_id) VALUES
    (orion_session, org_id, 'orion', 'fixture', 'conversation', orion_key),
    (other_session, org_id, 'orion', 'fixture', 'conversation', orion_key),
    (vega_session, org_id, 'vega', 'fixture', 'conversation', vega_key),
    (memory_session, org_id, 'orion', 'fixture', 'memory', NULL);
  INSERT INTO public.function_changes(org_id, session_id, project_scope, source_exchange_id,
    confidence, old_name, new_name, change_type, is_suppressed) VALUES
    (org_id, orion_session, 'orion', old_exchange, 0.9, 'oldFn', NULL, 'deprecated', false),
    (org_id, orion_session, 'orion', new_exchange, 0.9, 'oldFn', 'newFn', 'renamed', false),
    (org_id, orion_session, 'orion', ambiguous_exchange, 0.9, 'oneFn', NULL, 'deprecated', false),
    (org_id, orion_session, 'orion', ambiguous_exchange, 0.9, 'twoFn', NULL, 'deprecated', false),
    (org_id, orion_session, 'orion', suppressed_exchange, 0.9, 'hiddenFn', 'hiddenNew', 'renamed', true),
    (org_id, other_session, 'orion', new_exchange, 0.9, 'otherSessionFn', 'otherNew', 'renamed', false),
    (org_id, vega_session, 'vega', old_exchange, 0.9, 'vegaFn', 'vegaNew', 'renamed', false),
    (org_id, memory_session, 'orion', NULL, 0.9, 'legacyFn', NULL, 'deprecated', false);
  SELECT array_agg(entity_name ORDER BY entity_name) INTO names
    FROM public.find_exchange_function_entities(org_id, orion_session, 'orion',
      ARRAY[old_exchange, new_exchange, ambiguous_exchange, suppressed_exchange]);
  IF names IS DISTINCT FROM ARRAY['newFn', 'oldFn']::text[] THEN
    RAISE EXCEPTION 'Orion exchange mapping leaked or kept ambiguous facts: %', names;
  END IF;
  SELECT array_agg(entity_name) INTO names
    FROM public.find_exchange_function_entities(org_id, vega_session, 'vega', ARRAY[old_exchange]);
  IF names IS DISTINCT FROM ARRAY['vegaNew']::text[] THEN RAISE EXCEPTION 'Vega exchange mapping crossed project'; END IF;
  IF EXISTS (SELECT 1 FROM public.find_exchange_function_entities(org_id, orion_session, 'vega', ARRAY[old_exchange]))
    OR EXISTS (SELECT 1 FROM public.find_exchange_function_entities(org_id, memory_session, 'orion', ARRAY[old_exchange]))
    OR EXISTS (SELECT 1 FROM public.find_exchange_function_entities(other_org, orion_session, 'orion', ARRAY[old_exchange])) THEN
    RAISE EXCEPTION 'wrong project, session kind, or organization resolved';
  END IF;
  IF (SELECT array_agg(superseded || '>' || superseded_by)
      FROM public.find_fresh_exchange_function_superseded(org_id, orion_session, 'orion',
        ARRAY[old_exchange, new_exchange, ambiguous_exchange, suppressed_exchange]))
      IS DISTINCT FROM ARRAY['oldFn>newFn']::text[] THEN
    RAISE EXCEPTION 'fresh rename relation leaked or disappeared';
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_fresh_exchange_function_superseded(org_id, orion_session, 'orion', ARRAY[old_exchange]))
    OR EXISTS (SELECT 1 FROM public.find_fresh_exchange_function_superseded(org_id, orion_session, 'vega', ARRAY[new_exchange]))
    OR EXISTS (SELECT 1 FROM public.find_fresh_exchange_function_superseded(other_org, orion_session, 'orion', ARRAY[new_exchange])) THEN
    RAISE EXCEPTION 'fresh relation used an unselected exchange or foreign binding';
  END IF;
  INSERT INTO public.knowledge_entities(id, org_id, session_id, kind, name, project_scope, scope_verified, provenance_complete) VALUES
    (decision_old, org_id, orion_session, 'Decision', 'oldFn', 'orion', true, true),
    (decision_new, org_id, orion_session, 'Decision', 'newFn', 'orion', true, true),
    (function_old, org_id, orion_session, 'Function', 'oldFn', 'orion', true, true),
    (function_new, org_id, orion_session, 'Function', 'newFn', 'orion', true, true);
  INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type,
    project_scope, scope_verified, provenance_complete)
    VALUES (org_id, orion_session, decision_new, decision_old, 'SUPERSEDES', 'orion', true, true);
  IF EXISTS (SELECT 1 FROM public.find_project_function_superseded(org_id, 'orion', ARRAY['oldFn'])) THEN
    RAISE EXCEPTION 'Decision name collision counted as Function supersession';
  END IF;
  INSERT INTO public.knowledge_edges(org_id, session_id, from_entity, to_entity, edge_type,
    project_scope, scope_verified, provenance_complete)
    VALUES (org_id, orion_session, function_new, function_old, 'SUPERSEDES', 'orion', true, true);
  IF (SELECT array_agg(superseded_by) FROM public.find_project_function_superseded(org_id, 'orion', ARRAY['oldFn']))
      IS DISTINCT FROM ARRAY['newFn']::text[] THEN
    RAISE EXCEPTION 'Function supersession relation missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.find_project_function_superseded(org_id, 'vega', ARRAY['oldFn'])) THEN
    RAISE EXCEPTION 'Function supersession relation crossed project';
  END IF;
  BEGIN
    INSERT INTO public.function_changes(org_id, session_id, project_scope, source_exchange_id,
      confidence, old_name, change_type)
      VALUES (org_id, memory_session, 'orion', gen_random_uuid(), 0.9, 'forgedFn', 'deprecated');
    RAISE EXCEPTION 'legacy memory session accepted an exchange ID';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'legacy memory session accepted an exchange ID' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.find_exchange_function_entities(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_exchange_function_entities(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_exchange_function_entities(uuid,uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'exchange lookup grants are wrong';
  END IF;
  IF has_function_privilege('anon', 'public.find_project_function_superseded(uuid,text,text[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_project_function_superseded(uuid,text,text[])', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_project_function_superseded(uuid,text,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'function supersession lookup grants are wrong';
  END IF;
  IF has_function_privilege('anon', 'public.find_fresh_exchange_function_superseded(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_fresh_exchange_function_superseded(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_fresh_exchange_function_superseded(uuid,uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'fresh function supersession lookup grants are wrong';
  END IF;
END;
$$;
ROLLBACK;
