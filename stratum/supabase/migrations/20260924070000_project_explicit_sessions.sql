-- Commercial explicit sessions retain their authenticated project at creation.
-- Use the same organization advisory lock as the legacy personal-mode RPC so
-- concurrent keys in different projects cannot evade the organization cap.
CREATE FUNCTION public.create_project_session_if_under_cap(
  p_org_id uuid, p_model text, p_cap integer, p_project_scope text
)
RETURNS SETOF public.sessions
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('session_cap:' || p_org_id::text)::bigint);
  IF (SELECT count(*) FROM public.sessions
      WHERE org_id = p_org_id AND kind = 'explicit' AND ended_at IS NULL) >= p_cap THEN
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO public.sessions (org_id, model, kind, project_scope)
    VALUES (p_org_id, p_model, 'explicit', p_project_scope)
    RETURNING *;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_project_session_if_under_cap(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_project_session_if_under_cap(uuid, text, integer, text)
  TO service_role;
