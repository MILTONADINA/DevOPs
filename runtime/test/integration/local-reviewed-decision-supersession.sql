-- Disposable PostgreSQL acceptance check; all fixture rows roll back.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_error(statement text, expected text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(expected IN SQLERRM) = 0 THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected rejection containing: %', expected;
END;
$$;

INSERT INTO public.organizations(name) VALUES ('review fixture A') RETURNING id AS org_a \gset
INSERT INTO public.organizations(name) VALUES ('review fixture B') RETURNING id AS org_b \gset
INSERT INTO public.sessions(org_id, project_scope, model)
  VALUES (:'org_a', 'orion', 'local-check') RETURNING id AS session_a \gset
INSERT INTO public.sessions(org_id, project_scope, model)
  VALUES (:'org_a', 'vega', 'local-check') RETURNING id AS session_vega \gset
INSERT INTO public.sessions(org_id, project_scope, model)
  VALUES (:'org_b', 'orion', 'local-check') RETURNING id AS session_b \gset

INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_a', :'session_a', 'orion', '2026-09-20', 0.9, 'old runtime', 'runtime') RETURNING id AS old_a \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_a', :'session_a', 'orion', '2026-09-21', 0.9, 'new runtime', 'runtime') RETURNING id AS new_a \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_a', :'session_a', 'orion', '2026-09-22', 0.9, 'another runtime', 'runtime') RETURNING id AS another_a \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_a', :'session_a', 'orion', '2026-09-20', 0.9, 'equal-time runtime', 'runtime') RETURNING id AS equal_a \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain, is_suppressed)
  VALUES (:'org_a', :'session_a', 'orion', '2026-09-19', 0.9, 'suppressed runtime', 'runtime', true) RETURNING id AS suppressed_a \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_a', :'session_vega', 'vega', '2026-09-19', 0.9, 'vega runtime', 'runtime') RETURNING id AS old_vega \gset
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, created_at, confidence, decision_text, domain)
  VALUES (:'org_b', :'session_b', 'orion', '2026-09-19', 0.9, 'foreign runtime', 'runtime') RETURNING id AS old_b \gset

SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'new_a', :'old_b', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'organization or project mismatch');
SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'new_a', :'old_vega', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'organization or project mismatch');
SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'new_a', :'new_a', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'cannot supersede itself');
SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'equal_a', :'old_a', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'requires active older decision');
SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'new_a', :'suppressed_a', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'requires active older decision');
SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'new_a', :'old_a', '', 'Reviewed replacement from explicit runbook change.'
), 'tech_decisions_reviewed_link');

SELECT public.review_tech_decision_supersession(
  :'org_a', 'orion', :'new_a', :'old_a', 'operator@example.test',
  'Reviewed replacement from explicit runbook change.'
) AS linked \gset
SELECT set_config('devops_test.linked', :'linked', true),
       set_config('devops_test.older', :'old_a', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tech_decisions
    WHERE id = current_setting('devops_test.linked')::uuid
      AND supersedes_id = current_setting('devops_test.older')::uuid
      AND supersession_reviewer = 'operator@example.test'
      AND supersession_evidence = 'Reviewed replacement from explicit runbook change.'
      AND supersession_reviewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reviewed link missing';
  END IF;
END;
$$;

SELECT pg_temp.expect_error(format(
  'SELECT public.review_tech_decision_supersession(%L,%L,%L,%L,%L,%L)',
  :'org_a', 'orion', :'another_a', :'old_a', 'operator@example.test', 'Reviewed replacement from explicit runbook change.'
), 'tech_decisions_one_successor');
SELECT pg_temp.expect_error(format(
  'UPDATE public.tech_decisions SET supersession_evidence = %L WHERE id = %L',
  'changed evidence', :'new_a'
), 'reviewed decision supersession is immutable');
SELECT pg_temp.expect_error(format(
  'UPDATE public.tech_decisions SET created_at = %L WHERE id = %L',
  '2026-09-22', :'old_a'
), 'linked decision identity is immutable');
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.review_tech_decision_supersession(uuid,text,uuid,uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.review_tech_decision_supersession(uuid,text,uuid,uuid,text,text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.review_tech_decision_supersession(uuid,text,uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'review RPC grants incorrect';
  END IF;
END;
$$;
ROLLBACK;
