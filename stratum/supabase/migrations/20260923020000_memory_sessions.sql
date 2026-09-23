-- Automatic per-request fact sessions are distinct from explicit client
-- sessions and daily billing usage buckets.
ALTER TABLE public.sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_kind_check
  CHECK (kind IN ('explicit', 'usage', 'memory'));
