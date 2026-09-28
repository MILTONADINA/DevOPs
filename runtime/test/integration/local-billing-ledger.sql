-- Disposable proof of the v0.9 append-only financial ledger. No row commits.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.organizations(name) VALUES ('DevOPs billing ledger check') RETURNING id AS org_id \gset
INSERT INTO public.sessions(org_id, model) VALUES (:'org_id'::uuid, 'local-check') RETURNING id AS session_id \gset
INSERT INTO public.billing_records(session_id, org_id, original_tokens, quarantined_tokens, api_price_per_token, signed_hash)
VALUES (:'session_id'::uuid, :'org_id'::uuid, 1000, 600, 0.00001, 'fixture-signature') RETURNING id AS record_id \gset
SELECT set_config('devops_test.billing_id', :'record_id', true);

DO $$
DECLARE
  bill_id uuid := current_setting('devops_test.billing_id')::uuid;
  bill public.billing_records%ROWTYPE;
BEGIN
  SELECT * INTO STRICT bill FROM public.billing_records WHERE id = bill_id;
  IF bill.token_delta <> 400 OR bill.cost_delta_usd <> 0.004000 OR bill.cq_fee_usd <> 0.000800 THEN
    RAISE EXCEPTION 'billing generated columns did not match immutable inputs';
  END IF;

  BEGIN
    UPDATE public.billing_records SET original_tokens = 1001 WHERE id = bill_id;
    RAISE EXCEPTION 'UPDATE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'billing_records is append-only: UPDATE is forbidden' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.billing_records(id, session_id, org_id, original_tokens, quarantined_tokens, api_price_per_token, signed_hash)
    VALUES (bill_id, bill.session_id, bill.org_id, 1001, 600, 0.00001, 'fixture-signature')
    ON CONFLICT (id) DO UPDATE SET original_tokens = EXCLUDED.original_tokens;
    RAISE EXCEPTION 'UPSERT unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'billing_records is append-only: UPDATE is forbidden' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM public.billing_records WHERE id = bill_id;
    RAISE EXCEPTION 'DELETE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'billing_records is append-only: DELETE is forbidden' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE public.billing_records;
    RAISE EXCEPTION 'TRUNCATE unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'billing_records is append-only: TRUNCATE is forbidden' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM public.sessions WHERE id = bill.session_id;
    RAISE EXCEPTION 'referenced session DELETE unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  IF NOT EXISTS (SELECT 1 FROM public.billing_records WHERE id = bill_id AND original_tokens = 1000) THEN
    RAISE EXCEPTION 'ledger row changed after rejected mutations';
  END IF;
  RAISE NOTICE 'billing generated values, UPDATE/UPSERT/DELETE/TRUNCATE rejection, and session FK retention passed';
END;
$$;
ROLLBACK;
