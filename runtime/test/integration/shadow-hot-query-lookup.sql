-- Independent fact-rich workload; every row rolls back.
BEGIN;
DO $$
DECLARE
  org_id uuid := gen_random_uuid();
  key_id uuid := gen_random_uuid();
  target_session uuid := gen_random_uuid();
  successor_session uuid := gen_random_uuid();
  target_exchange uuid := gen_random_uuid();
  unrelated_exchange uuid := gen_random_uuid();
  older_id uuid := gen_random_uuid();
  newer_id uuid := gen_random_uuid();
  target_count bigint;
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org_id, 'hot query lookup fixture');
  INSERT INTO public.api_keys(id, org_id, project_scope, key_hash, name)
    VALUES (key_id, org_id, 'orion', repeat('e', 64), 'fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model, kind, conversation_key_id)
    VALUES (target_session, org_id, 'orion', 'fixture', 'conversation', key_id),
      (successor_session, org_id, 'orion', 'fixture', 'conversation', key_id);
  INSERT INTO public.operational_references(org_id, session_id, project_scope,
    source_exchange_id, created_at, confidence, subject, reference, is_suppressed)
    VALUES (org_id, target_session, 'orion', target_exchange,
      '2026-01-01T00:00:00Z', 0.9, 'runbook', 'RUNBOOK_RECOVERY.md', false),
      (org_id, target_session, 'orion', unrelated_exchange,
      '2026-01-01T00:00:00Z', 0.9, 'billing receipt', 'INVOICE.md', false),
      (org_id, target_session, 'orion', target_exchange,
      '2026-01-01T00:00:00Z', 0.9, 'runbook hidden', 'HIDDEN.md', true);
  INSERT INTO public.tech_decisions(id, org_id, session_id, project_scope,
    source_exchange_id, created_at, confidence, decision_text, domain)
    VALUES (older_id, org_id, target_session, 'orion', target_exchange,
      '2026-01-01T00:00:00Z', 0.9, 'Use the old runbook', 'operations'),
      (newer_id, org_id, successor_session, 'orion', gen_random_uuid(),
      '2026-09-23T00:00:00Z', 0.9, 'Use the new runbook', 'operations');
  INSERT INTO public.function_changes(org_id, session_id, project_scope,
    source_exchange_id, confidence, old_name, file_path, change_type)
    VALUES (org_id, target_session, 'orion', target_exchange, 0.9,
      'runbook', 'runbook.ts', 'deprecated');
  INSERT INTO public.policy_updates(org_id, session_id, project_scope,
    source_exchange_id, confidence, policy_name, new_value, policy_type)
    VALUES (org_id, target_session, 'orion', target_exchange, 0.9,
      'runbook policy', 'current', 'process');
  INSERT INTO public.todos(org_id, session_id, project_scope,
    source_exchange_id, confidence, description)
    VALUES (org_id, target_session, 'orion', target_exchange, 0.9,
      'Review runbook');
  INSERT INTO public.variable_changes(org_id, session_id, project_scope,
    source_exchange_id, confidence, var_name, new_value)
    VALUES (org_id, target_session, 'orion', target_exchange, 0.9,
      'RUNBOOK_PATH', 'current');
  PERFORM public.review_tech_decision_supersession(org_id, 'orion', newer_id,
    older_id, 'fixture-reviewer', 'Reviewed the current operations runbook replacement.');

  WITH added AS (
    INSERT INTO public.sessions(id, org_id, project_scope, model, kind, conversation_key_id)
      SELECT gen_random_uuid(), org_id, 'orion', 'fixture', 'conversation', key_id
      FROM generate_series(1, 25)
      RETURNING id
  )
  INSERT INTO public.operational_references(org_id, session_id, project_scope,
    source_exchange_id, created_at, confidence, subject, reference)
    SELECT org_id, id, 'orion', gen_random_uuid(), '2026-09-23T00:00:00Z',
      0.9, repeat('runbook ', 8), 'other project conversation'
    FROM added;

  IF EXISTS (
    SELECT 1 FROM public.search_project_warm_facts(org_id, 'orion', 'runbook', 20) hit
    WHERE hit.fact->>'source_exchange_id' = target_exchange::text
  ) THEN
    RAISE EXCEPTION 'project-wide top 20 unexpectedly included the target exchange';
  END IF;

  SELECT fact_count INTO target_count
    FROM public.find_query_hot_fact_exchanges(org_id, target_session, 'orion',
      ARRAY[target_exchange, unrelated_exchange], 'runbook')
    WHERE exchange_id = target_exchange;
  IF target_count IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'exact hot lookup lost current runbook fact: %', target_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.find_query_hot_fact_exchanges(org_id, target_session, 'orion',
      ARRAY[target_exchange, unrelated_exchange], 'runbook')
    WHERE exchange_id = unrelated_exchange
  ) OR EXISTS (
    SELECT 1 FROM public.find_query_hot_fact_exchanges(org_id, target_session, 'vega',
      ARRAY[target_exchange], 'runbook')
  ) OR EXISTS (
    SELECT 1 FROM public.find_query_hot_fact_exchanges(gen_random_uuid(), target_session, 'orion',
      ARRAY[target_exchange], 'runbook')
  ) THEN
    RAISE EXCEPTION 'exact hot lookup included irrelevant or foreign facts';
  END IF;

  UPDATE public.tech_decisions SET is_suppressed = true WHERE id = newer_id;
  SELECT fact_count INTO target_count
    FROM public.find_query_hot_fact_exchanges(org_id, target_session, 'orion',
      ARRAY[target_exchange], 'runbook')
    WHERE exchange_id = target_exchange;
  IF target_count IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'suppressed successor did not restore older decision: %', target_count;
  END IF;
  IF has_function_privilege('anon', 'public.find_query_hot_fact_exchanges(uuid,uuid,text,uuid[],text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.find_query_hot_fact_exchanges(uuid,uuid,text,uuid[],text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.find_query_hot_fact_exchanges(uuid,uuid,text,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hot query lookup grants are wrong';
  END IF;
END;
$$;
ROLLBACK;
