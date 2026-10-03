-- specs/memory/session-erasure.md REQ-8/14 and AC-B12: negative-only restore
-- admission for an absent organization, before the first active table insert.
-- This commits independently of the importer. Row guards remain authoritative
-- for intervening conflicts; neither bulk atomicity nor complete history is implied.
CREATE FUNCTION public.prepare_erasure_restore(
  p_org_id uuid, p_session_ids uuid[], p_fact_ids uuid[], p_entity_ids uuid[]
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE source_id uuid;
BEGIN
  PERFORM public.require_erasure_read_committed();
  IF p_org_id IS NULL OR p_session_ids IS NULL OR p_fact_ids IS NULL OR p_entity_ids IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'restore identities required';
  END IF;
  IF COALESCE(pg_catalog.array_ndims(p_session_ids), 1) <> 1
    OR COALESCE(pg_catalog.array_ndims(p_fact_ids), 1) <> 1
    OR COALESCE(pg_catalog.array_ndims(p_entity_ids), 1) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'restore identity arrays must be one dimensional';
  END IF;
  IF pg_catalog.array_position(p_session_ids, NULL) IS NOT NULL
    OR pg_catalog.array_position(p_fact_ids, NULL) IS NOT NULL
    OR pg_catalog.array_position(p_entity_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'restore identity arrays cannot contain null';
  END IF;
  PERFORM id FROM public.erasure_deployment WHERE id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'restore authority unavailable';
  END IF;
  -- lock_erasure_org requires an existing org. Import instead takes the same
  -- serialization lock before any caller-supplied organization can be inserted.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('session_cap:' || p_org_id::text)::bigint);
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org_id)
    OR EXISTS (SELECT 1 FROM public.session_erasure_state WHERE org_id = p_org_id AND state = 'erasing') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'restore target unavailable';
  END IF;
  FOR source_id IN SELECT DISTINCT id FROM pg_catalog.unnest(p_session_ids) AS incoming(id) ORDER BY id LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('erasure_session:' || source_id::text)::bigint);
  END LOOP;
  FOR source_id IN SELECT DISTINCT id FROM pg_catalog.unnest(p_entity_ids) AS incoming(id) ORDER BY id LOOP
    PERFORM public.lock_erasure_source('entity', source_id);
  END LOOP;
  FOR source_id IN SELECT DISTINCT id FROM pg_catalog.unnest(p_fact_ids) AS incoming(id) ORDER BY id LOOP
    PERFORM public.lock_erasure_source('fact', source_id);
  END LOOP;
  -- Fresh READ COMMITTED queries after every source lock, including foreign IDs.
  IF EXISTS (SELECT 1 FROM public.session_erasure_state WHERE session_id = ANY(p_session_ids))
    OR EXISTS (SELECT 1 FROM public.session_erasure_state WHERE state = 'complete'
      AND (erased_fact_ids && p_fact_ids OR erased_entity_ids && p_entity_ids)) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'restore identity is retained by erasure authority';
  END IF;
  INSERT INTO public.erasure_org_coverage(org_id, unknown_at, unknown_reason)
    VALUES (p_org_id, pg_catalog.clock_timestamp(), 'restore_import')
    ON CONFLICT (org_id) DO UPDATE
      SET unknown_at = COALESCE(public.erasure_org_coverage.unknown_at, EXCLUDED.unknown_at),
          unknown_reason = COALESCE(public.erasure_org_coverage.unknown_reason, EXCLUDED.unknown_reason);
  RETURN true;
END;
$$;
GRANT USAGE, CREATE ON SCHEMA public TO devops_erasure_executor;
ALTER FUNCTION public.prepare_erasure_restore(uuid,uuid[],uuid[],uuid[]) OWNER TO devops_erasure_executor;
REVOKE CREATE ON SCHEMA public FROM devops_erasure_executor;
REVOKE ALL ON FUNCTION public.prepare_erasure_restore(uuid,uuid[],uuid[],uuid[])
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.prepare_erasure_restore(uuid,uuid[],uuid[],uuid[]) TO service_role;
