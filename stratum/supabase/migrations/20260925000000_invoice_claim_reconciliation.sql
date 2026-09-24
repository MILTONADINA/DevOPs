-- Recover a provider-verified invoice under its existing durable period claim.
-- The webhook may have inserted the Stripe ID first with NULL period columns;
-- reconcile that row in one transaction instead of attempting a second insert.
CREATE FUNCTION public.reconcile_claimed_invoice(
  p_org_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_invoice_id text,
  p_amount_cents integer,
  p_status text,
  p_paid_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  prior public.invoices%ROWTYPE;
BEGIN
  IF p_org_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start OR p_stripe_invoice_id IS NULL
     OR p_stripe_invoice_id = '' OR p_amount_cents IS NULL OR p_amount_cents <= 0
     OR p_status IS NULL OR p_status NOT IN ('sent', 'paid')
     OR (p_status = 'paid' AND p_paid_at IS NULL)
     OR (p_status = 'sent' AND p_paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid invoice reconciliation input';
  END IF;

  PERFORM 1 FROM public.invoice_send_claims
    WHERE org_id = p_org_id AND period_start = p_period_start
      AND period_end = p_period_end;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice period claim is missing';
  END IF;

  SELECT * INTO prior FROM public.invoices
    WHERE stripe_invoice_id = p_stripe_invoice_id FOR UPDATE;
  IF FOUND THEN
    IF prior.org_id <> p_org_id OR prior.amount_cents <> p_amount_cents
       OR prior.currency <> 'usd'
       OR (prior.period_start IS NULL) <> (prior.period_end IS NULL)
       OR (prior.period_start IS NOT NULL AND
           (prior.period_start <> p_period_start OR prior.period_end <> p_period_end))
       OR (prior.status = 'paid' AND p_status <> 'paid')
       OR (prior.status = 'failed' AND p_status <> 'paid') THEN
      RAISE EXCEPTION 'existing Stripe invoice conflicts with reconciliation';
    END IF;
    UPDATE public.invoices SET
      period_start = p_period_start,
      period_end = p_period_end,
      status = p_status,
      paid_at = CASE WHEN prior.status = 'paid' AND prior.paid_at IS NOT NULL
                     THEN prior.paid_at ELSE p_paid_at END,
      updated_at = now()
    WHERE id = prior.id;
  ELSE
    INSERT INTO public.invoices
      (org_id, stripe_invoice_id, amount_cents, currency, status,
       period_start, period_end, paid_at)
    VALUES
      (p_org_id, p_stripe_invoice_id, p_amount_cents, 'usd', p_status,
       p_period_start, p_period_end, p_paid_at);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_claimed_invoice(uuid, timestamptz, timestamptz, text, integer, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_claimed_invoice(uuid, timestamptz, timestamptz, text, integer, text, timestamptz)
  TO service_role;
