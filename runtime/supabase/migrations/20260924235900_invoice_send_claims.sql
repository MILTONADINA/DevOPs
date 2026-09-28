-- Claim an org/period before any Stripe invoice request. A claim persists after
-- ambiguous errors so a concurrent or later runner cannot issue a second bill
-- until an operator reconciles Stripe and the local invoices ledger.
CREATE TABLE public.invoice_send_claims (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, period_start, period_end),
  CONSTRAINT invoice_send_claims_increasing_period CHECK (period_end > period_start)
);

ALTER TABLE public.invoice_send_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invoice_send_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.invoice_send_claims TO service_role;
