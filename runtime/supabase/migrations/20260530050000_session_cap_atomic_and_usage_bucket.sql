-- 20260530050000_session_cap_atomic_and_usage_bucket.sql
-- Session-23 audit remediation: atomic concurrent-session cap + one-usage-bucket-per-day invariant.

-- (A) Atomic concurrent-session cap. The route previously did getPlan → countActiveSessions → createSession
-- as three non-atomic steps: two parallel POSTs could both observe "active < cap" and both insert (a TOCTOU
-- cap bypass — a starter org, cap 1, could open N sessions by racing N requests). A per-org advisory lock
-- (transaction-scoped, auto-released) serializes the check+insert so the cap holds under any concurrency.
CREATE OR REPLACE FUNCTION public.create_session_if_under_cap(p_org_id uuid, p_model text, p_cap integer)
RETURNS SETOF public.sessions
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Serialize all session-create attempts for this org (does NOT block other orgs).
  PERFORM pg_advisory_xact_lock(hashtext('session_cap:' || p_org_id::text)::bigint);
  IF (SELECT count(*) FROM public.sessions
       WHERE org_id = p_org_id AND kind = 'explicit' AND ended_at IS NULL) >= p_cap THEN
    RETURN; -- at/over cap → empty result (the app maps this to HTTP 429)
  END IF;
  RETURN QUERY
    INSERT INTO public.sessions (org_id, model, kind)
    VALUES (p_org_id, p_model, 'explicit')
    RETURNING *;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_session_if_under_cap(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_session_if_under_cap(uuid, text, integer) TO service_role;

-- (B) One usage bucket per (org, model, UTC-day). The usage recorder's in-memory cache dedups within ONE
-- instance, but concurrent Vercel instances each miss their own cache and would insert DUPLICATE kind='usage'
-- sessions, fragmenting a day's billing_records across many session ids. This partial unique index enforces
-- the invariant at the DB layer; the recorder does select-or-insert (on a 23505 it re-reads the winner row).
-- (date(... AT TIME ZONE 'UTC') is IMMUTABLE on PG15+, verified acceptable for a unique index.)
CREATE UNIQUE INDEX IF NOT EXISTS sessions_usage_bucket_uniq
  ON public.sessions (org_id, model, (date(created_at AT TIME ZONE 'UTC')))
  WHERE kind = 'usage';
