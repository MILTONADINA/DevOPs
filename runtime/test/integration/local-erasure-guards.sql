-- specs/memory/session-erasure.md REQ-11/14, AC-B5/B6/B12.
-- Parent-only isolated c4b-erasure database run. All fixtures roll back.
-- Privileged fence/receipt setup below is NEGATIVE guard setup, not proof of
-- prepare/execute, real completion, or an activated production deployment.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.guard_assert(condition boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION '%', label; END IF;
END;
$$;
CREATE FUNCTION pg_temp.guard_error(statement text, label text, state text DEFAULT '55000')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state IS DISTINCT FROM state THEN
      RAISE EXCEPTION '%: expected %, got % (%)', label, state, actual_state, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION '%: unsafe statement was accepted', label;
END;
$$;
CREATE FUNCTION pg_temp.guard_fact(kind text, org uuid, session uuid, identity uuid DEFAULT gen_random_uuid())
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  CASE kind
    WHEN 'function_changes' THEN INSERT INTO public.function_changes(id,org_id,session_id,confidence,old_name,change_type,file_path)
      VALUES(identity,org,session,.9,'guard-function','deprecated','guard.ts');
    WHEN 'tech_decisions' THEN INSERT INTO public.tech_decisions(id,org_id,session_id,confidence,decision_text,domain)
      VALUES(identity,org,session,.9,'guard decision','guard.ts');
    WHEN 'policy_updates' THEN INSERT INTO public.policy_updates(id,org_id,session_id,confidence,policy_name,new_value,policy_type)
      VALUES(identity,org,session,.9,'guard policy','enabled','security');
    WHEN 'todos' THEN INSERT INTO public.todos(id,org_id,session_id,confidence,description)
      VALUES(identity,org,session,.9,'guard todo');
    WHEN 'variable_changes' THEN INSERT INTO public.variable_changes(id,org_id,session_id,confidence,var_name,new_value)
      VALUES(identity,org,session,.9,'guard variable','new');
    WHEN 'operational_references' THEN INSERT INTO public.operational_references(id,org_id,session_id,confidence,subject,reference)
      VALUES(identity,org,session,.9,'guard reference','guard.ts');
    ELSE RAISE EXCEPTION 'unsupported fixture fact';
  END CASE;
  RETURN identity;
END;
$$;
CREATE FUNCTION pg_temp.guard_embedding() RETURNS vector LANGUAGE sql AS $$
  SELECT ('[' || array_to_string(array_fill(0,ARRAY[384]),',') || ']')::vector;
$$;
CREATE FUNCTION pg_temp.guard_snapshot(org uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb := '{}'::jsonb; name text; rows jsonb;
BEGIN
  FOREACH name IN ARRAY ARRAY['sessions','billing_records','function_changes','tech_decisions',
    'policy_updates','todos','variable_changes','operational_references','audit_conflicts',
    'audit_statuses','knowledge_entities','knowledge_edges','knowledge_entity_sessions',
    'knowledge_edge_sessions','source_fact_links','memory_vectors'] LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), ''[]''::jsonb) FROM public.%I r WHERE org_id=$1',name)
      INTO rows USING org;
    result := result || jsonb_build_object(name,rows);
  END LOOP;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) INTO rows
    FROM public.pruning_logs p JOIN public.sessions s ON s.id=p.session_id WHERE s.org_id=org;
  RETURN result || jsonb_build_object('pruning_logs',rows);
END;
$$;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
    (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.guard_assert(boolean,text),
  pg_temp.guard_error(text,text,text),pg_temp.guard_fact(text,uuid,uuid,uuid),
  pg_temp.guard_snapshot(uuid),pg_temp.guard_embedding() TO service_role;

BEGIN;
SET LOCAL statement_timeout='10s';
CREATE TEMP TABLE guard_ids(label text PRIMARY KEY,id uuid NOT NULL);
CREATE TEMP TABLE guard_values(label text PRIMARY KEY,value jsonb NOT NULL);
GRANT SELECT,INSERT,UPDATE ON pg_temp.guard_ids,pg_temp.guard_values TO service_role;
CREATE FUNCTION pg_temp.g(label text) RETURNS uuid LANGUAGE sql AS
  'SELECT id FROM pg_temp.guard_ids WHERE guard_ids.label=$1';
GRANT EXECUTE ON FUNCTION pg_temp.g(text) TO service_role;
SELECT pg_temp.guard_assert((SELECT count(*)=1 AND bool_and(NOT enabled) FROM public.erasure_deployment),
  'guard fixture requires a disabled deployment');

SET LOCAL ROLE service_role;
WITH o AS (INSERT INTO public.organizations(name) VALUES('C4B guards unknown fixture') RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'legacy-org',id FROM o;
INSERT INTO pg_temp.guard_ids SELECT 'legacy-session',id FROM public.create_session_if_under_cap(pg_temp.g('legacy-org'),'guards',20);
INSERT INTO pg_temp.guard_ids VALUES ('retired-session',gen_random_uuid()),('retired-fact',gen_random_uuid()),('retired-entity',gen_random_uuid());
RESET ROLE;
-- Only a synthetic negative tombstone; no real source/session ever had these IDs.
INSERT INTO public.session_erasure_state(org_id,session_id,activation_id,state,request_id,prepared_at,completed_at,receipt,erased_fact_ids,erased_entity_ids)
  VALUES(pg_temp.g('legacy-org'),pg_temp.g('retired-session'),gen_random_uuid(),'complete',gen_random_uuid(),clock_timestamp(),clock_timestamp(),
    '{"status":"complete","fixture":"negative-guard-only"}',ARRAY[pg_temp.g('retired-fact')],ARRAY[pg_temp.g('retired-entity')]);
SET LOCAL ROLE service_role;
-- Expected RED on foundation200/graph300: this ordinary write currently succeeds.
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,''fact'',%L,pg_temp.guard_embedding())',
  pg_temp.g('legacy-org'),pg_temp.g('retired-fact')::text),
  'AC-B6: retired source accepted from unknown org');
SELECT pg_temp.guard_assert(public.mark_erasure_coverage_unknown(pg_temp.g('legacy-org'),'protected_read'),
  'negative tombstone org did not retain sticky uncertainty');
DO $$
DECLARE kind text; ref text; retired uuid;
BEGIN
  FOREACH kind IN ARRAY ARRAY['fact','entity'] LOOP
    retired:=pg_temp.g('retired-'||kind);
    FOREACH ref IN ARRAY ARRAY[retired::text,upper(retired::text),'{'||retired::text||'}',replace(retired::text,'-','')] LOOP
      PERFORM pg_temp.guard_error(format(
        'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,%L,%L,pg_temp.guard_embedding())',
        pg_temp.g('legacy-org'),kind,ref),'AC-B6: equivalent retired UUID escaped '||kind);
      PERFORM pg_temp.guard_error(format(
        'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,''turn'',%L,pg_temp.guard_embedding())',
        pg_temp.g('legacy-org'),ref),'AC-B6: retired UUID relabeled as turn escaped');
    END LOOP;
  END LOOP;
  FOREACH kind IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'] LOOP
    PERFORM pg_temp.guard_error(format('SELECT pg_temp.guard_fact(%L,%L,%L,%L)',kind,
      pg_temp.g('legacy-org'),pg_temp.g('legacy-session'),pg_temp.g('retired-fact')),
      'AC-B6: retired fact identity reused in '||kind);
  END LOOP;
END $$;
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.knowledge_entities(id,org_id,session_id,kind,name) VALUES(%L,%L,%L,''Function'',''retired'')',
  pg_temp.g('retired-entity'),pg_temp.g('legacy-org'),pg_temp.g('legacy-session')),'AC-B6: retired entity reused');
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.audit_statuses(org_id,fact_table,fact_id,status) VALUES(%L,''todos'',%L,''CONFIRMED'')',
  pg_temp.g('legacy-org'),pg_temp.g('retired-fact')),'AC-B6: retired audit reference reused');

-- Ordinary unknown legacy orphan vectors remain supported (including omitted and opaque references).
INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding) VALUES
  (pg_temp.g('legacy-org'),NULL,'fact',gen_random_uuid()::text,pg_temp.guard_embedding()),
  (pg_temp.g('legacy-org'),pg_temp.g('legacy-session'),'entity',gen_random_uuid()::text,pg_temp.guard_embedding()),
  (pg_temp.g('legacy-org'),NULL,'fact','bench-guard-opaque',pg_temp.guard_embedding()),
  (pg_temp.g('legacy-org'),NULL,'turn',NULL,pg_temp.guard_embedding());
SELECT pg_temp.guard_assert((SELECT count(*)=4 FROM public.memory_vectors WHERE org_id=pg_temp.g('legacy-org'))
  AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('legacy-org')),
  'AC-B6: unrelated unknown legacy vectors lost compatibility or gained coverage');

-- Operator activation is rollback-only. Positive coverage uses actual mint/cap RPCs.
RESET ROLE;
UPDATE public.erasure_deployment SET enabled=true,activation_id=gen_random_uuid(),activated_at=clock_timestamp(),
  source_manifest_sha256=repeat('a',64) WHERE id; -- Synthetic SQL unit digest; no artifact attestation.
SET LOCAL ROLE service_role;
INSERT INTO pg_temp.guard_ids SELECT 'org',id FROM public.create_managed_organization('C4B guards fresh fixture','growth');
INSERT INTO pg_temp.guard_ids SELECT 'foreign-org',id FROM public.create_managed_organization('C4B guards foreign fixture','growth');
INSERT INTO pg_temp.guard_ids SELECT 'target',id FROM public.create_session_if_under_cap(pg_temp.g('org'),'guards-target',20);
INSERT INTO pg_temp.guard_ids SELECT 'survivor',id FROM public.create_session_if_under_cap(pg_temp.g('org'),'guards-survivor',20);
INSERT INTO pg_temp.guard_ids SELECT 'other',id FROM public.create_session_if_under_cap(pg_temp.g('org'),'guards-other',20);
INSERT INTO pg_temp.guard_ids SELECT 'foreign-session',id FROM public.create_session_if_under_cap(pg_temp.g('foreign-org'),'guards-foreign',20);
INSERT INTO pg_temp.guard_ids SELECT 'foreign-fact',pg_temp.guard_fact('todos',pg_temp.g('foreign-org'),pg_temp.g('foreign-session'));
DO $$
DECLARE kind text;
BEGIN
  FOREACH kind IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'] LOOP
    INSERT INTO pg_temp.guard_ids VALUES('target-'||kind,pg_temp.guard_fact(kind,pg_temp.g('org'),pg_temp.g('target')));
    INSERT INTO pg_temp.guard_ids VALUES('survivor-'||kind,pg_temp.guard_fact(kind,pg_temp.g('org'),pg_temp.g('survivor')));
  END LOOP;
END $$;
WITH e AS (INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,file_path,scope_verified,provenance_complete)
  VALUES(pg_temp.g('org'),pg_temp.g('target'),'File','guard.ts','guard.ts',true,true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'file',id FROM e;
WITH e AS (INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,scope_verified,provenance_complete)
  VALUES(pg_temp.g('org'),pg_temp.g('survivor'),'Function','guard shared',true,true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'shared',id FROM e;
WITH e AS (INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,scope_verified,provenance_complete)
  VALUES(pg_temp.g('org'),pg_temp.g('other'),'Function','guard unrelated',true,true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'unrelated',id FROM e;
INSERT INTO public.knowledge_entity_sessions(org_id,entity_id,session_id)
  VALUES(pg_temp.g('org'),pg_temp.g('shared'),pg_temp.g('target'));
WITH e AS (INSERT INTO public.knowledge_edges(org_id,session_id,from_entity,to_entity,edge_type,scope_verified,provenance_complete)
  VALUES(pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('file'),pg_temp.g('shared'),'REFERENCED_IN',true,true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'edge',id FROM e;
INSERT INTO public.knowledge_edge_sessions(org_id,edge_id,session_id)
  VALUES(pg_temp.g('org'),pg_temp.g('edge'),pg_temp.g('target'));
WITH p AS (INSERT INTO public.pruning_logs(session_id,turns_total,lambda_used,gain_shift_used,theta_used)
  VALUES(pg_temp.g('target'),1,.97,0,1) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'prune',id FROM p;
WITH p AS (INSERT INTO public.pruning_logs(session_id,turns_total,lambda_used,gain_shift_used,theta_used)
  VALUES(pg_temp.g('survivor'),1,.97,0,1) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'survivor-prune',id FROM p;
WITH p AS (INSERT INTO public.pruning_logs(session_id,turns_total,lambda_used,gain_shift_used,theta_used)
  VALUES(pg_temp.g('foreign-session'),1,.97,0,1) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'foreign-prune',id FROM p;
WITH b AS (INSERT INTO public.billing_records(org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token)
  VALUES(pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('prune'),100,20,.00000101) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'usage',id FROM b;
INSERT INTO public.audit_statuses(org_id,fact_table,fact_id,status)
  SELECT pg_temp.g('org'),substr(label,8),id,'UNVERIFIED' FROM pg_temp.guard_ids
    WHERE label IN ('target-function_changes','target-tech_decisions','target-policy_updates','target-todos','target-variable_changes','target-operational_references');
WITH a AS (INSERT INTO public.audit_conflicts(org_id,session_id,fact_table,fact_id,claimed_state,actual_state)
  VALUES(pg_temp.g('org'),pg_temp.g('survivor'),'todos',pg_temp.g('target-todos'),'claimed','actual') RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'conflict',id FROM a;
-- Different own-session values must not mask a source's target ownership.
WITH v AS (INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
  VALUES(pg_temp.g('org'),pg_temp.g('target'),'fact',pg_temp.g('target-function_changes')::text,pg_temp.guard_embedding()) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'vector-own',id FROM v;
WITH v AS (INSERT INTO public.memory_vectors(org_id,session_id,source_type,source_ref,embedding)
  VALUES(pg_temp.g('org'),pg_temp.g('survivor'),'fact',pg_temp.g('target-policy_updates')::text,pg_temp.guard_embedding()) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'vector-other',id FROM v;
WITH v AS (INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding)
  VALUES(pg_temp.g('org'),'fact',pg_temp.g('target-variable_changes')::text,pg_temp.guard_embedding()) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'vector-null',id FROM v;
WITH v AS (INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding)
  VALUES(pg_temp.g('org'),'fact',pg_temp.g('survivor-variable_changes')::text,pg_temp.guard_embedding()) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'vector-survivor',id FROM v;
SELECT pg_temp.guard_assert(
  (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org'))
  AND (SELECT count(*)=3 FROM public.session_erasure_state WHERE org_id=pg_temp.g('org') AND state='active')
  AND (SELECT count(*)=4 FROM public.knowledge_entity_sessions WHERE org_id=pg_temp.g('org'))
  AND (SELECT count(*)=2 FROM public.knowledge_edge_sessions WHERE org_id=pg_temp.g('org'))
  AND (SELECT count(*)=4 FROM public.source_fact_links WHERE org_id=pg_temp.g('org')),
  'AC-B6: ordinary valid writers lost coverage or origin/source links');

-- Warm persistence uses upsert(ignoreDuplicates): the BEFORE INSERT guard must
-- accept the exact existing table/org/session identity without downgrading it.
DO $$
DECLARE kind text; before_rows jsonb:=pg_temp.guard_snapshot(pg_temp.g('org'));
BEGIN
  FOREACH kind IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'] LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM public.%I WHERE id=$1 ON CONFLICT(id) DO NOTHING',kind,kind)
      USING pg_temp.g('target-'||kind);
  END LOOP;
  PERFORM pg_temp.guard_assert(pg_temp.guard_snapshot(pg_temp.g('org'))=before_rows
    AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),
    'AC-B6: ordinary same-identity warm retry changed content or coverage');
END $$;

-- Missing/ambiguous/foreign generic ownership cannot silently remain covered.
DO $$
DECLARE ref text; kind text;
BEGIN
  FOREACH ref IN ARRAY ARRAY[NULL,'malformed',gen_random_uuid()::text,'{'||pg_temp.g('target-todos')::text||'}',pg_temp.g('foreign-fact')::text] LOOP
    PERFORM pg_temp.guard_error(format(
      'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,''fact'',%L,pg_temp.guard_embedding())',
      pg_temp.g('org'),ref),'AC-B6: covered unresolved/noncanonical/foreign vector accepted');
  END LOOP;
  FOREACH kind IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'] LOOP
    PERFORM pg_temp.guard_error(format('SELECT pg_temp.guard_fact(%L,%L,%L,%L)',kind,pg_temp.g('org'),pg_temp.g('target'),pg_temp.g('foreign-fact')),
      'AC-B6: covered cross-table/global fact UUID collision accepted');
  END LOOP;
END $$;
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,''fact'',%L,pg_temp.guard_embedding())',
  pg_temp.g('legacy-org'),pg_temp.g('foreign-fact')::text),'AC-B6: unknown org referenced existing foreign fact');
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.audit_statuses(org_id,fact_table,fact_id,status) VALUES(%L,''todos'',%L,''CONFIRMED'')',
  pg_temp.g('org'),gen_random_uuid()),'AC-B6: covered missing audit source accepted');
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.billing_records(org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token) VALUES(%L,%L,%L,10,2,.00001)',
  pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('foreign-prune')),'AC-B6: foreign pruning ownership accepted');

INSERT INTO pg_temp.guard_values VALUES('before-fence',pg_temp.guard_snapshot(pg_temp.g('org')));
SAVEPOINT negative_fence;
RESET ROLE;
UPDATE public.session_erasure_state SET state='erasing',request_id=gen_random_uuid(),prepared_at=clock_timestamp()
  WHERE session_id=pg_temp.g('target');
SET LOCAL ROLE service_role;
DO $$
DECLARE kind text; row_id uuid; label text;
BEGIN
  FOREACH kind IN ARRAY ARRAY['function_changes','tech_decisions','policy_updates','todos','variable_changes','operational_references'] LOOP
    row_id:=pg_temp.g('target-'||kind);
    PERFORM pg_temp.guard_error(format('INSERT INTO public.%I SELECT * FROM public.%I WHERE id=%L ON CONFLICT(id) DO NOTHING',kind,kind,row_id),'AC-B6: fenced warm retry escaped '||kind);
    PERFORM pg_temp.guard_error(format('SELECT pg_temp.guard_fact(%L,%L,%L)',kind,pg_temp.g('org'),pg_temp.g('target')),'AC-B6: late fact insert '||kind);
    PERFORM pg_temp.guard_error(format('UPDATE public.%I SET confidence=.8 WHERE id=%L',kind,row_id),'AC-B6: fenced fact update '||kind);
    PERFORM pg_temp.guard_error(format('DELETE FROM public.%I WHERE id=%L',kind,row_id),'AC-B6: fenced fact delete '||kind);
    PERFORM pg_temp.guard_error(format('UPDATE public.%I SET session_id=%L WHERE id=%L',kind,pg_temp.g('survivor'),row_id),'AC-B6: old fact ownership escaped '||kind);
    PERFORM pg_temp.guard_error(format('UPDATE public.%I SET session_id=%L WHERE id=%L',kind,pg_temp.g('target'),pg_temp.g('survivor-'||kind)),'AC-B6: new fact ownership escaped '||kind);
    PERFORM pg_temp.guard_error(format('UPDATE public.audit_statuses SET status=''CONFIRMED'' WHERE org_id=%L AND fact_table=%L AND fact_id=%L',pg_temp.g('org'),kind,row_id),'AC-B6: indirect audit status update '||kind);
    PERFORM pg_temp.guard_error(format('DELETE FROM public.audit_statuses WHERE org_id=%L AND fact_table=%L AND fact_id=%L',pg_temp.g('org'),kind,row_id),'AC-B6: indirect audit status delete '||kind);
  END LOOP;
  FOREACH label IN ARRAY ARRAY['vector-own','vector-other','vector-null'] LOOP
    row_id:=pg_temp.g(label);
    PERFORM pg_temp.guard_error(format('UPDATE public.memory_vectors SET source_ref=%L,session_id=NULL WHERE id=%L',gen_random_uuid()::text,row_id),'AC-B6: old nullable/source vector association escaped');
    PERFORM pg_temp.guard_error(format('DELETE FROM public.memory_vectors WHERE id=%L',row_id),'AC-B6: indirect vector delete escaped');
  END LOOP;
  PERFORM pg_temp.guard_error(format('UPDATE public.memory_vectors SET source_ref=%L WHERE id=%L',pg_temp.g('target-operational_references')::text,pg_temp.g('vector-survivor')),'AC-B6: new nullable vector source escaped');
  PERFORM pg_temp.guard_error(format('UPDATE public.memory_vectors SET session_id=%L WHERE id=%L',pg_temp.g('target'),pg_temp.g('vector-survivor')),'AC-B6: new nullable vector session escaped');
END $$;
SELECT pg_temp.guard_error(format('UPDATE public.pruning_logs SET session_id=%L WHERE id=%L',pg_temp.g('survivor'),pg_temp.g('prune')),'AC-B6: old pruning session escaped');
SELECT pg_temp.guard_error(format('UPDATE public.pruning_logs SET session_id=%L WHERE id=%L',pg_temp.g('target'),pg_temp.g('survivor-prune')),'AC-B6: new pruning session escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.pruning_logs WHERE id=%L',pg_temp.g('prune')),'AC-B6: fenced pruning delete');
SELECT pg_temp.guard_error(format('UPDATE public.billing_records SET pruning_log_id=NULL WHERE id=%L',pg_temp.g('usage')),'AC-B6: old indirect usage ownership escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.billing_records WHERE id=%L',pg_temp.g('usage')),'AC-B6: indirect usage delete escaped');
SELECT pg_temp.guard_error(format('INSERT INTO public.billing_records(org_id,session_id,pruning_log_id,original_tokens,quarantined_tokens,api_price_per_token) VALUES(%L,%L,%L,10,2,.00001)',pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('prune')),'AC-B6: new indirect usage source escaped');
SELECT pg_temp.guard_error(format('UPDATE public.audit_conflicts SET fact_id=%L WHERE id=%L',pg_temp.g('survivor-todos'),pg_temp.g('conflict')),'AC-B6: old indirect audit source escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.audit_conflicts WHERE id=%L',pg_temp.g('conflict')),'AC-B6: indirect audit delete escaped');
SELECT pg_temp.guard_error(format('INSERT INTO public.audit_conflicts(org_id,session_id,fact_table,fact_id,claimed_state,actual_state) VALUES(%L,%L,''todos'',%L,''claim'',''actual'')',pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('target-todos')),'AC-B6: new indirect audit source escaped');
SELECT pg_temp.guard_error(format('UPDATE public.knowledge_entities SET summary=''late'' WHERE id=%L',pg_temp.g('shared')),'AC-B6: shared entity provenance fence escaped');
SELECT pg_temp.guard_error(format('UPDATE public.knowledge_entities SET session_id=%L WHERE id=%L',pg_temp.g('target'),pg_temp.g('unrelated')),'AC-B6: new entity origin fence escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.knowledge_entities WHERE id=%L',pg_temp.g('file')),'AC-B6: private entity delete escaped');
SELECT pg_temp.guard_error(format('UPDATE public.knowledge_edges SET from_entity=%L,to_entity=%L WHERE id=%L',pg_temp.g('unrelated'),pg_temp.g('shared'),pg_temp.g('edge')),'AC-B6: old endpoint ownership escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.knowledge_edges WHERE id=%L',pg_temp.g('edge')),'AC-B6: edge provenance delete escaped');
SELECT pg_temp.guard_error(format('INSERT INTO public.knowledge_edges(org_id,session_id,from_entity,to_entity,edge_type,scope_verified,provenance_complete) VALUES(%L,%L,%L,%L,''APPLIES_TO'',true,true)',pg_temp.g('org'),pg_temp.g('survivor'),pg_temp.g('unrelated'),pg_temp.g('shared')),'AC-B6: new endpoint provenance fence escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.knowledge_entity_sessions WHERE org_id=%L AND entity_id=%L AND session_id=%L',pg_temp.g('org'),pg_temp.g('shared'),pg_temp.g('target')),'AC-B6: entity provenance delete escaped');
SELECT pg_temp.guard_error(format('UPDATE public.knowledge_entity_sessions SET session_id=%L WHERE org_id=%L AND entity_id=%L AND session_id=%L',pg_temp.g('other'),pg_temp.g('org'),pg_temp.g('shared'),pg_temp.g('target')),'AC-B6: old entity provenance escaped');
SELECT pg_temp.guard_error(format('INSERT INTO public.knowledge_entity_sessions(org_id,entity_id,session_id) VALUES(%L,%L,%L)',pg_temp.g('org'),pg_temp.g('unrelated'),pg_temp.g('target')),'AC-B6: new entity provenance escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.knowledge_edge_sessions WHERE org_id=%L AND edge_id=%L',pg_temp.g('org'),pg_temp.g('edge')),'AC-B6: edge provenance delete escaped');
SELECT pg_temp.guard_error(format('UPDATE public.knowledge_edge_sessions SET session_id=%L WHERE org_id=%L AND edge_id=%L AND session_id=%L',pg_temp.g('other'),pg_temp.g('org'),pg_temp.g('edge'),pg_temp.g('target')),'AC-B6: old edge provenance escaped');
SELECT pg_temp.guard_error(format('DELETE FROM public.source_fact_links WHERE org_id=%L AND file_entity_id=%L',pg_temp.g('org'),pg_temp.g('file')),'AC-B6: source link old ownership escaped');
SELECT pg_temp.guard_error(format('UPDATE public.source_fact_links SET function_change_id=%L WHERE function_change_id=%L',pg_temp.g('survivor-function_changes'),pg_temp.g('target-function_changes')),'AC-B6: source link retarget escaped');
-- Post-red coverage for475's direct-session entry branch, including an empty audit batch.
SELECT pg_temp.guard_error(format('SELECT public.persist_audit_results(%L,%L,''[]''::jsonb)',pg_temp.g('org'),pg_temp.g('target')),'AC-B6: empty audit batch ignored direct session fence');
SELECT pg_temp.guard_error(format('SELECT public.persist_audit_results(%L,%L,%L::jsonb)',pg_temp.g('org'),pg_temp.g('survivor'),jsonb_build_array(jsonb_build_object('fact_table','todos','fact_id',pg_temp.g('target-todos'),'status','CONFIRMED'))::text),'AC-B6: audit RPC ignored indirect fence');
SELECT pg_temp.guard_assert(pg_temp.guard_snapshot(pg_temp.g('org'))=(SELECT value FROM pg_temp.guard_values WHERE label='before-fence'),
  'AC-B6: rejected guarded operation changed content');
SELECT pg_temp.guard_assert((SELECT state='erasing' FROM public.session_erasure_state WHERE session_id=pg_temp.g('target'))
  AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),
  'AC-B6: rejection lost fence or falsely committed uncertainty');
ROLLBACK TO negative_fence;

-- A no-op preserves completeness; real content updates downgrade it and durably
-- mark uncertainty after observing the existing BEFORE provenance trigger.
SAVEPOINT graph_mutation;
UPDATE public.knowledge_entities SET summary=summary WHERE id=pg_temp.g('shared');
SELECT pg_temp.guard_assert((SELECT provenance_complete FROM public.knowledge_entities WHERE id=pg_temp.g('shared'))
  AND (SELECT unknown_at IS NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),'AC-B6: no-op graph update downgraded coverage');
UPDATE public.knowledge_entities SET summary='actual content change' WHERE id=pg_temp.g('shared');
SELECT pg_temp.guard_assert((SELECT NOT provenance_complete FROM public.knowledge_entities WHERE id=pg_temp.g('shared'))
  AND (SELECT unknown_at IS NOT NULL AND unknown_reason='unattributed_write' FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),
  'AC-B6: graph content/provenance mutation stayed falsely clean');
ROLLBACK TO graph_mutation;
SAVEPOINT provenance_delete;
DELETE FROM public.knowledge_entity_sessions WHERE entity_id=pg_temp.g('shared') AND session_id=pg_temp.g('target');
SELECT pg_temp.guard_assert((SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),
  'AC-B6: provenance removal hid prior reuse while preserving clean coverage');
ROLLBACK TO provenance_delete;
SAVEPOINT audit_suppression;
SELECT pg_temp.guard_assert(public.persist_audit_results(pg_temp.g('org'),pg_temp.g('survivor'),jsonb_build_array(jsonb_build_object(
  'id',gen_random_uuid(),'fact_table','function_changes','fact_id',pg_temp.g('target-function_changes'),
  'status','CONFLICT','claimed_state','claimed','actual_state','observed','conflict_commit','fixture')))=1,
  'AC-B6: ordinary atomic audit conflict no longer persists');
SELECT pg_temp.guard_assert((SELECT is_suppressed FROM public.function_changes WHERE id=pg_temp.g('target-function_changes'))
  AND NOT EXISTS(SELECT 1 FROM public.source_fact_links WHERE function_change_id=pg_temp.g('target-function_changes'))
  AND (SELECT status='CONFLICT' FROM public.audit_statuses WHERE org_id=pg_temp.g('org') AND fact_table='function_changes' AND fact_id=pg_temp.g('target-function_changes'))
  AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('org')),
  'AC-B6: audit/source-link mutation lost atomic suppression or uncertainty');
ROLLBACK TO audit_suppression;

-- Real unknown legacy cascades: parent fact/entity is already invisible to a
-- dependent BEFORE DELETE guard. Do not preclear dependencies to fake this case.
WITH e AS (INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,file_path,scope_verified)
  VALUES(pg_temp.g('legacy-org'),pg_temp.g('legacy-session'),'File','guard.ts','guard.ts',true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'legacy-file',id FROM e;
WITH e AS (INSERT INTO public.knowledge_entities(org_id,session_id,kind,name,scope_verified)
  VALUES(pg_temp.g('legacy-org'),pg_temp.g('legacy-session'),'Function','legacy-survivor',true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'legacy-entity',id FROM e;
INSERT INTO pg_temp.guard_ids VALUES('legacy-fact',pg_temp.guard_fact('function_changes',pg_temp.g('legacy-org'),pg_temp.g('legacy-session'))),
  ('legacy-fact-survivor',pg_temp.guard_fact('function_changes',pg_temp.g('legacy-org'),pg_temp.g('legacy-session')));
WITH e AS (INSERT INTO public.knowledge_edges(org_id,session_id,from_entity,to_entity,edge_type,scope_verified)
  VALUES(pg_temp.g('legacy-org'),pg_temp.g('legacy-session'),pg_temp.g('legacy-file'),pg_temp.g('legacy-entity'),'REFERENCED_IN',true) RETURNING id)
  INSERT INTO pg_temp.guard_ids SELECT 'legacy-edge',id FROM e;
INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding)
  VALUES(pg_temp.g('legacy-org'),'entity',pg_temp.g('legacy-file')::text,pg_temp.guard_embedding());
SELECT pg_temp.guard_assert((SELECT count(*)=2 FROM public.source_fact_links WHERE file_entity_id=pg_temp.g('legacy-file'))
  AND EXISTS(SELECT 1 FROM public.knowledge_edge_sessions WHERE edge_id=pg_temp.g('legacy-edge')),
  'AC-B6: legacy cascade prerequisites were empty');
DELETE FROM public.function_changes WHERE id=pg_temp.g('legacy-fact');
SELECT pg_temp.guard_assert(NOT EXISTS(SELECT 1 FROM public.source_fact_links WHERE function_change_id=pg_temp.g('legacy-fact'))
  AND EXISTS(SELECT 1 FROM public.source_fact_links WHERE function_change_id=pg_temp.g('legacy-fact-survivor')),
  'AC-B6: ordinary fact cascade lost retained source link');
DELETE FROM public.knowledge_entities WHERE id=pg_temp.g('legacy-file');
SELECT pg_temp.guard_assert(NOT EXISTS(SELECT 1 FROM public.knowledge_edges WHERE id=pg_temp.g('legacy-edge'))
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_edge_sessions WHERE edge_id=pg_temp.g('legacy-edge'))
  AND NOT EXISTS(SELECT 1 FROM public.knowledge_entity_sessions WHERE entity_id=pg_temp.g('legacy-file'))
  AND NOT EXISTS(SELECT 1 FROM public.source_fact_links WHERE file_entity_id=pg_temp.g('legacy-file'))
  AND EXISTS(SELECT 1 FROM public.function_changes WHERE id=pg_temp.g('legacy-fact-survivor'))
  AND EXISTS(SELECT 1 FROM public.knowledge_entities WHERE id=pg_temp.g('legacy-entity'))
  AND EXISTS(SELECT 1 FROM public.memory_vectors WHERE source_type='entity' AND source_ref=pg_temp.g('legacy-file')::text)
  AND (SELECT unknown_at IS NOT NULL FROM public.erasure_org_coverage WHERE org_id=pg_temp.g('legacy-org')),
  'AC-B6: ordinary entity cascade or supported unknown orphan behavior changed');

ROLLBACK;
-- Reject unsupported isolation before even classifying nonexistent/legacy refs.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE service_role;
SELECT pg_temp.guard_error(format(
  'INSERT INTO public.memory_vectors(org_id,source_type,source_ref,embedding) VALUES(%L,''fact'',''opaque'',pg_temp.guard_embedding())',gen_random_uuid()),
  'AC-B5: legacy vector path used stale repeatable-read snapshot','0A000');
SELECT pg_temp.guard_error(format('SELECT public.persist_audit_results(%L,%L,''[]'')',gen_random_uuid(),gen_random_uuid()),
  'AC-B5: audit RPC read ownership before isolation check','0A000');
ROLLBACK;
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.guard_error(format('SELECT pg_temp.guard_fact(''todos'',%L,%L)',gen_random_uuid(),gen_random_uuid()),
  'AC-B5: fact path used stale serializable snapshot','0A000');
ROLLBACK;
SELECT pg_temp.guard_assert((SELECT count(*)=1 AND bool_and(NOT enabled) FROM public.erasure_deployment),
  'guard fixture activation escaped rollback');
\echo 'C4B guard fixture passed (rollback-only; race/executor proof remains separate)'
