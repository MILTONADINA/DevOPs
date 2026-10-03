-- specs/ops/payment-removal.md#AC-4: unsigned mutable usage ledger, with
-- retained event uniqueness, estimates, RLS and session references. No row commits.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.organizations(name) VALUES ('DevOPs unsigned usage ledger check') RETURNING id AS org_id \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_id'::uuid, 'local-check') RETURNING id AS session_id \gset
INSERT INTO public.billing_records(session_id, org_id, original_tokens, quarantined_tokens, api_price_per_token, usage_event_id)
VALUES (:'session_id'::uuid, :'org_id'::uuid, 1000, 600, 0.00001, gen_random_uuid()) RETURNING id AS record_id \gset
SELECT set_config('devops_test.billing_id', :'record_id', true);

DO $$
DECLARE
  bill_id uuid := current_setting('devops_test.billing_id')::uuid;
  bill public.billing_records%ROWTYPE;
BEGIN
  SELECT * INTO STRICT bill FROM public.billing_records WHERE id = bill_id;
  IF bill.token_delta <> 400 OR bill.cost_delta_usd <> 0.004000
     OR bill.api_price_per_token <> 0.00001 OR bill.usage_event_id IS NULL THEN
    RAISE EXCEPTION 'usage generated estimates or pinned inputs were not retained';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'billing_records' AND column_name IN ('cq_fee_usd', 'signed_hash'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.billing_records'::regclass
      AND tgname IN ('trg_billing_records_no_update', 'trg_billing_records_no_delete', 'trg_billing_records_no_truncate'))
     OR to_regprocedure('public.billing_records_immutable()') IS NOT NULL THEN
    RAISE EXCEPTION 'retired payment columns or immutability enforcement remain';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_records'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'billing_records') THEN
    RAISE EXCEPTION 'usage ledger service-only RLS posture changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.billing_records_usage_event_uniq')
      AND indrelid = 'public.billing_records'::regclass AND indisunique AND indisvalid) THEN
    RAISE EXCEPTION 'usage event unique index was not retained';
  END IF;

  -- This tests the DB uniqueness guard. The TypeScript writer integration
  -- separately proves input-equality replay instead of accepting every conflict.
  BEGIN
    INSERT INTO public.billing_records(session_id, org_id, original_tokens, quarantined_tokens, api_price_per_token, usage_event_id)
    VALUES (bill.session_id, bill.org_id, 1000, 600, 0.00001, bill.usage_event_id);
    RAISE EXCEPTION 'duplicate usage event unexpectedly inserted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  IF (SELECT count(*) FROM public.billing_records WHERE usage_event_id = bill.usage_event_id) <> 1 THEN
    RAISE EXCEPTION 'duplicate usage event changed row count';
  END IF;

  UPDATE public.billing_records SET original_tokens = 1001 WHERE id = bill_id;
  IF NOT EXISTS (SELECT 1 FROM public.billing_records WHERE id = bill_id
      AND original_tokens = 1001 AND token_delta = 401 AND cost_delta_usd = 0.004010
      AND api_price_per_token = 0.00001 AND usage_event_id = bill.usage_event_id) THEN
    RAISE EXCEPTION 'usage UPDATE was blocked or failed to recompute estimates';
  END IF;

  BEGIN
    DELETE FROM public.sessions WHERE id = bill.session_id;
    RAISE EXCEPTION 'referenced session DELETE unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  DELETE FROM public.billing_records WHERE id = bill_id;
  IF EXISTS (SELECT 1 FROM public.billing_records WHERE id = bill_id) THEN
    RAISE EXCEPTION 'fixture-scoped usage DELETE was blocked';
  END IF;
  RAISE NOTICE 'unsigned usage insert, event uniqueness, estimates, UPDATE/DELETE, RLS and session FK retention passed';
END;
$$;
ROLLBACK;
