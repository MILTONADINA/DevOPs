-- Disposable current-fact coverage check; all rows roll back.
BEGIN;
DO $$
DECLARE
  org_id uuid := gen_random_uuid();
  key_id uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  newer_session_id uuid := gen_random_uuid();
  older_exchange uuid := gen_random_uuid();
  newer_exchange uuid := gen_random_uuid();
  older_id uuid := gen_random_uuid();
  newer_id uuid := gen_random_uuid();
  old_count bigint;
  new_count bigint;
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org_id, 'shadow reviewed coverage fixture');
  INSERT INTO public.api_keys(id, org_id, project_scope, key_hash, name)
    VALUES (key_id, org_id, 'orion', repeat('c', 64), 'fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model, kind, conversation_key_id)
    VALUES (session_id, org_id, 'orion', 'fixture', 'conversation', key_id),
      (newer_session_id, org_id, 'orion', 'fixture', 'conversation', key_id);
  INSERT INTO public.tech_decisions(id, org_id, session_id, project_scope, source_exchange_id,
    created_at, confidence, decision_text, domain) VALUES
    (older_id, org_id, session_id, 'orion', older_exchange,
      '2026-09-20T00:00:00Z', 0.9, 'Use MongoDB', 'database'),
    (newer_id, org_id, newer_session_id, 'orion', newer_exchange,
      '2026-09-24T00:00:00Z', 0.9, 'Use PostgreSQL', 'database');
  INSERT INTO public.operational_references(org_id, session_id, project_scope,
    source_exchange_id, confidence, subject, reference)
    VALUES (org_id, session_id, 'orion', older_exchange, 0.9,
      'Recovery runbook', 'RUNBOOK_RECOVERY.md');

  SELECT fact_count INTO old_count FROM public.find_active_fact_exchanges(
    org_id, session_id, 'orion', ARRAY[older_exchange])
    WHERE exchange_id = older_exchange;
  SELECT fact_count INTO new_count FROM public.find_active_fact_exchanges(
    org_id, newer_session_id, 'orion', ARRAY[newer_exchange])
    WHERE exchange_id = newer_exchange;
  IF old_count IS DISTINCT FROM 2 OR new_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'pre-review counts incorrect: old %, new %', old_count, new_count;
  END IF;

  PERFORM public.review_tech_decision_supersession(org_id, 'orion', newer_id,
    older_id, 'fixture-reviewer', 'Reviewed replacement of MongoDB with PostgreSQL.');
  SELECT fact_count INTO old_count FROM public.find_active_fact_exchanges(
    org_id, session_id, 'orion', ARRAY[older_exchange])
    WHERE exchange_id = older_exchange;
  SELECT fact_count INTO new_count FROM public.find_active_fact_exchanges(
    org_id, newer_session_id, 'orion', ARRAY[newer_exchange])
    WHERE exchange_id = newer_exchange;
  IF old_count IS DISTINCT FROM 1 OR new_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'reviewed decision inflated active coverage: old %, new %', old_count, new_count;
  END IF;

  UPDATE public.tech_decisions SET is_suppressed = true WHERE id = newer_id;
  SELECT fact_count INTO old_count FROM public.find_active_fact_exchanges(
    org_id, session_id, 'orion', ARRAY[older_exchange])
    WHERE exchange_id = older_exchange;
  SELECT fact_count INTO new_count FROM public.find_active_fact_exchanges(
    org_id, newer_session_id, 'orion', ARRAY[newer_exchange])
    WHERE exchange_id = newer_exchange;
  IF old_count IS DISTINCT FROM 2 OR new_count IS NOT NULL THEN
    RAISE EXCEPTION 'suppressed successor did not restore older coverage: old %, new %', old_count, new_count;
  END IF;
  IF has_function_privilege('anon', 'public.find_active_fact_exchanges(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_active_fact_exchanges(uuid,uuid,text,uuid[])', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_active_fact_exchanges(uuid,uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'shadow coverage lookup grants changed';
  END IF;
END;
$$;
ROLLBACK;
