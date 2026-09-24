-- Disposable acceptance fixture; every row rolls back.
BEGIN;
DO $$
DECLARE
  org_one uuid := gen_random_uuid();
  org_two uuid := gen_random_uuid();
  key_one uuid := gen_random_uuid();
  key_two uuid := gen_random_uuid();
  conversation uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name) VALUES (org_one, 'conversation fixture one'), (org_two, 'conversation fixture two');
  INSERT INTO public.api_keys (id, org_id, key_hash, name) VALUES
    (key_one, org_one, encode(gen_random_bytes(32), 'hex'), 'one'),
    (key_two, org_two, encode(gen_random_bytes(32), 'hex'), 'two');
  INSERT INTO public.sessions (id, org_id, conversation_key_id, kind, model, project_scope)
    VALUES (conversation, org_one, key_one, 'conversation', 'fixture', 'orion');
  IF EXISTS (SELECT 1 FROM public.sessions WHERE id = conversation AND kind = 'explicit') THEN
    RAISE EXCEPTION 'conversation appeared in explicit session query';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions WHERE id = conversation AND org_id = org_one
    AND conversation_key_id = key_one AND project_scope = 'orion' AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'trusted conversation lookup failed';
  END IF;
  BEGIN
    INSERT INTO public.sessions (org_id, conversation_key_id, kind, model)
      VALUES (org_one, key_two, 'conversation', 'fixture');
    RAISE EXCEPTION 'cross-organization key insert was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.sessions (org_id, kind, model)
      VALUES (org_one, 'conversation', 'fixture');
    RAISE EXCEPTION 'unbound conversation insert was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.sessions SET conversation_key_id = key_two WHERE id = conversation;
    RAISE EXCEPTION 'conversation key mutation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'conversation key mutation was accepted' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
