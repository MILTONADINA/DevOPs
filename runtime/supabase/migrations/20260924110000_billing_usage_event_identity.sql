-- Existing append-only billing rows keep NULL and their legacy HMAC payload.
-- New usage events carry a server-generated UUID in the signed inputs so an
-- ambiguous insert can be replayed without creating a second charge.
ALTER TABLE public.billing_records ADD COLUMN usage_event_id uuid;
CREATE UNIQUE INDEX billing_records_usage_event_uniq
  ON public.billing_records (usage_event_id)
  WHERE usage_event_id IS NOT NULL;
