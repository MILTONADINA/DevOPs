-- Disposable selective-plan and full-RPC latency check; all rows roll back.
\set ON_ERROR_STOP on
BEGIN;
SELECT gen_random_uuid() AS org_id, gen_random_uuid() AS session_id \gset
INSERT INTO public.organizations(id, name) VALUES (:'org_id', 'lexical index fixture');
INSERT INTO public.sessions(id, org_id, project_scope, model)
  VALUES (:'session_id', :'org_id', 'orion', 'fixture');
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, confidence, decision_text, domain)
  SELECT :'org_id', :'session_id', 'orion', 0.9,
    'Routine operator note ' || n || ' for dashboard.', 'operations'
  FROM generate_series(1, 10000) n;
INSERT INTO public.tech_decisions(org_id, session_id, project_scope, confidence, decision_text, domain)
  VALUES (:'org_id', :'session_id', 'orion', 0.9,
    'graph dashboard route serves the project view', 'operations');
ANALYZE public.tech_decisions;

DO $$
DECLARE plan_line text; plan_text text := ''; target_org uuid := (SELECT id FROM public.organizations WHERE name = 'lexical index fixture');
BEGIN
  FOR plan_line IN EXECUTE format($q$
    EXPLAIN SELECT id FROM public.tech_decisions f
    WHERE org_id = %L AND project_scope = 'orion' AND NOT is_suppressed
      AND to_tsvector('simple'::regconfig,
        coalesce(decision_text, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(rationale, ''))
        @@ to_tsquery('simple', 'graph | route')
    ORDER BY ts_rank_cd(to_tsvector('simple'::regconfig,
      coalesce(decision_text, '') || ' ' || coalesce(domain, '') || ' ' || coalesce(rationale, '')),
      to_tsquery('simple', 'graph | route')) DESC
    LIMIT 20
  $q$, target_org) LOOP
    plan_text := plan_text || plan_line || E'\n';
  END LOOP;
  IF position('td_warm_lexical_gin_idx' IN plan_text) = 0 THEN
    RAISE EXCEPTION 'selective lexical query did not use decision GIN index: %', plan_text;
  END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('fc_warm_lexical_gin_idx', 'td_warm_lexical_gin_idx',
        'pu_warm_lexical_gin_idx', 'todos_warm_lexical_gin_idx', 'vc_warm_lexical_gin_idx')
      AND indexdef LIKE '%USING gin%' AND indexdef LIKE '%WHERE (NOT is_suppressed)%') <> 5 THEN
    RAISE EXCEPTION 'five partial typed lexical GIN indexes required';
  END IF;
  RAISE NOTICE 'selective lexical query used td_warm_lexical_gin_idx';
END;
$$;

EXPLAIN (ANALYZE, BUFFERS)
  WITH query AS (SELECT to_tsquery('simple', 'graph | route') AS terms)
  SELECT hit.id FROM query q CROSS JOIN LATERAL (
    SELECT f.id, ts_rank_cd(to_tsvector('simple'::regconfig,
      coalesce(f.decision_text, '') || ' ' || coalesce(f.domain, '') || ' ' || coalesce(f.rationale, '')),
      q.terms) AS score
    FROM public.tech_decisions f
    WHERE f.org_id = :'org_id' AND f.project_scope = 'orion' AND NOT f.is_suppressed
      AND to_tsvector('simple'::regconfig,
        coalesce(f.decision_text, '') || ' ' || coalesce(f.domain, '') || ' ' || coalesce(f.rationale, '')) @@ q.terms
    ORDER BY score DESC LIMIT 20
  ) hit;
EXPLAIN (ANALYZE, BUFFERS)
  SELECT fact_table, fact->>'id', lexical_score
  FROM public.search_project_warm_facts(:'org_id', 'orion', 'graph route', 20);
EXPLAIN (ANALYZE, BUFFERS)
  SELECT fact_table, fact->>'id', lexical_score
  FROM public.search_project_warm_facts(:'org_id', 'orion', 'graph dashboard route', 20);
ROLLBACK;
