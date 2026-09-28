-- Disposable trusted-scope and provenance check for the sixth warm fact.
BEGIN;
DO $$
DECLARE
  owner_id uuid := gen_random_uuid();
  foreign_id uuid := gen_random_uuid();
  key_id uuid := gen_random_uuid();
  conversation_id uuid := gen_random_uuid();
  memory_id uuid := gen_random_uuid();
  reference_id uuid := gen_random_uuid();
  rejected boolean;
BEGIN
  INSERT INTO public.organizations(id, name) VALUES
    (owner_id, 'operational reference fixture'), (foreign_id, 'foreign reference fixture');
  INSERT INTO public.api_keys(id, org_id, key_hash, name)
    VALUES (key_id, owner_id, gen_random_uuid()::text, 'fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model, kind, conversation_key_id)
    VALUES (conversation_id, owner_id, 'orion', 'fixture', 'conversation', key_id);
  INSERT INTO public.sessions(id, org_id, project_scope, model, kind)
    VALUES (memory_id, owner_id, 'orion', 'fixture', 'memory');
  INSERT INTO public.operational_references(id, org_id, session_id, project_scope,
    source_exchange_id, confidence, subject, reference)
    VALUES (reference_id, owner_id, conversation_id, 'orion', gen_random_uuid(),
      0.9, 'production recovery runbook', 'RUNBOOK_RECOVERY.md');
  INSERT INTO public.memory_vectors(org_id, session_id, source_type, source_ref, embedding)
    VALUES (owner_id, conversation_id, 'fact', reference_id::text,
      ('[' || array_to_string(ARRAY[1] || array_fill(0, ARRAY[383]), ',') || ']')::vector);
  IF (SELECT count(*) FROM public.operational_references WHERE id = reference_id
      AND org_id = owner_id AND project_scope = 'orion' AND NOT is_suppressed) <> 1 THEN
    RAISE EXCEPTION 'trusted reference was not stored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.search_project_warm_facts(owner_id, 'orion', 'RUNBOOK_RECOVERY.md', 20)
      WHERE fact_table = 'operational_references' AND fact->>'id' = reference_id::text) THEN
    RAISE EXCEPTION 'reference missing from exact-project lexical recall';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.match_project_fact_vectors(
       ('[' || array_to_string(ARRAY[1] || array_fill(0, ARRAY[383]), ',') || ']')::vector,
       owner_id, 'orion', 10) WHERE source_ref = reference_id::text) THEN
    RAISE EXCEPTION 'reference missing from exact-project vector recall';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'operational_references_warm_lexical_gin_idx'
      AND indexdef LIKE '%USING gin%' AND indexdef LIKE '%WHERE (NOT is_suppressed)%') THEN
    RAISE EXCEPTION 'reference lexical GIN index missing';
  END IF;
  rejected := false;
  BEGIN
    INSERT INTO public.operational_references(org_id, session_id, project_scope,
      confidence, subject, reference)
      VALUES (foreign_id, conversation_id, 'orion', 0.9, 'foreign', 'wrong');
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'foreign organization accepted'; END IF;
  rejected := false;
  BEGIN
    INSERT INTO public.operational_references(org_id, session_id, project_scope,
      confidence, subject, reference)
      VALUES (owner_id, conversation_id, 'vega', 0.9, 'foreign project', 'wrong');
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'foreign project accepted'; END IF;
  rejected := false;
  BEGIN
    INSERT INTO public.operational_references(org_id, session_id, project_scope,
      source_exchange_id, confidence, subject, reference)
      VALUES (owner_id, memory_id, 'orion', gen_random_uuid(), 0.9, 'forged exchange', 'wrong');
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'memory session exchange accepted'; END IF;
  rejected := false;
  BEGIN
    UPDATE public.operational_references SET source_exchange_id = gen_random_uuid()
      WHERE id = reference_id;
  EXCEPTION WHEN OTHERS THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'exchange provenance changed'; END IF;
  IF has_table_privilege('anon', 'public.operational_references', 'SELECT') OR
     has_table_privilege('authenticated', 'public.operational_references', 'SELECT') OR
     NOT has_table_privilege('service_role', 'public.operational_references', 'SELECT') OR
     NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.operational_references'::regclass) THEN
    RAISE EXCEPTION 'reference table grants or RLS incorrect';
  END IF;
END;
$$;
ROLLBACK;
