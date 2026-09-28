-- Migration: 20260530030000_sessions_kind_usage_vs_explicit.sql (PB-46)
-- The usage-recorder creates a sessions row per (org, UTC-day, model) that is NEVER ended (a daily
-- USAGE bucket), while POST /v1/sessions creates EXPLICIT live sessions. The concurrent-session cap
-- counts every ended_at IS NULL row, so accumulated usage buckets could push an org over its cap and
-- 429 the explicit API. Distinguish the two with `kind`; the cap query filters kind='explicit'.

ALTER TABLE sessions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'explicit' CHECK (kind IN ('explicit', 'usage'));

-- Supports the concurrent-cap query: count active EXPLICIT sessions per org.
CREATE INDEX sessions_org_active_explicit_idx ON sessions (org_id) WHERE ended_at IS NULL AND kind = 'explicit';
