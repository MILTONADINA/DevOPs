-- Billing rows are append-only, so preserve the authenticated project on their
-- usage session. Historical buckets remain NULL: their project is unknown.
-- Replace the old org/model/day uniqueness after project_scope was added to
-- sessions; NULLS NOT DISTINCT keeps one unbound bucket per day and model.
DROP INDEX public.sessions_usage_bucket_uniq;
CREATE UNIQUE INDEX sessions_usage_bucket_uniq
  ON public.sessions (org_id, model, project_scope, (date(created_at AT TIME ZONE 'UTC')))
  NULLS NOT DISTINCT
  WHERE kind = 'usage';
