-- Disposable vector ranking check for a reviewed decision replacement.
BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid();
  old_id uuid := gen_random_uuid();
  new_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  query_vector vector(384) := ('[' || array_to_string(ARRAY[1] || array_fill(0, ARRAY[383]), ',') || ']')::vector;
  top_ref text;
BEGIN
  INSERT INTO public.organizations(id, name) VALUES (org, 'reviewed vector fixture');
  INSERT INTO public.sessions(id, org_id, project_scope, model)
    VALUES (session_id, org, 'orion', 'fixture');
  INSERT INTO public.tech_decisions(id, org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
    VALUES (old_id, org, session_id, 'orion', '2026-09-20', 0.9, 'Use old runtime', 'runtime'),
           (new_id, org, session_id, 'orion', '2026-09-21', 0.9, 'Use new runtime', 'runtime'),
           (other_id, org, session_id, 'orion', '2026-09-19', 0.9, 'Other decision', 'runtime');
  INSERT INTO public.memory_vectors(org_id, session_id, source_type, source_ref, embedding)
    VALUES (org, session_id, 'fact', old_id::text, query_vector),
           (org, session_id, 'fact', new_id::text,
             ('[' || array_to_string(ARRAY[0.8, 0.6] || array_fill(0, ARRAY[382]), ',') || ']')::vector),
           (org, session_id, 'fact', other_id::text,
             ('[' || array_to_string(ARRAY[0.6, 0.8] || array_fill(0, ARRAY[382]), ',') || ']')::vector);

  SELECT source_ref INTO top_ref FROM public.match_project_fact_vectors(query_vector, org, 'orion', 1);
  IF top_ref IS DISTINCT FROM old_id::text THEN RAISE EXCEPTION 'baseline vector ranking is not old'; END IF;
  PERFORM public.review_tech_decision_supersession(org, 'orion', new_id, old_id,
    'fixture operator', 'Reviewed the newer runtime decision and replaced the old one.');

  SELECT source_ref INTO top_ref FROM public.match_project_fact_vectors(query_vector, org, 'orion', 1);
  IF top_ref IS DISTINCT FROM new_id::text THEN RAISE EXCEPTION 'reviewed old decision displaced the next eligible hit'; END IF;
  IF EXISTS (SELECT 1 FROM public.match_project_fact_vectors(query_vector, org, 'orion', 10)
    WHERE source_ref = old_id::text) THEN RAISE EXCEPTION 'reviewed old decision appeared in vector recall'; END IF;
  IF EXISTS (SELECT 1 FROM public.match_project_fact_vectors(query_vector, org, 'vega', 10)) THEN
    RAISE EXCEPTION 'vector recall crossed project';
  END IF;

  UPDATE public.tech_decisions SET is_suppressed = true WHERE id = new_id;
  SELECT source_ref INTO top_ref FROM public.match_project_fact_vectors(query_vector, org, 'orion', 1);
  IF top_ref IS DISTINCT FROM old_id::text THEN RAISE EXCEPTION 'suppressed successor still hid active old decision'; END IF;
  IF has_function_privilege('anon', 'public.match_project_fact_vectors(vector,uuid,text,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.match_project_fact_vectors(vector,uuid,text,integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.match_project_fact_vectors(vector,uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'vector RPC grants incorrect';
  END IF;
END;
$$;
ROLLBACK;
