-- specs/ops/payment-removal.md REQ-4: retain usage facts and estimated costs,
-- retire payment signatures/fees. The unsigned writer lands with this M1.
DROP TRIGGER trg_billing_records_no_update ON public.billing_records;
DROP TRIGGER trg_billing_records_no_delete ON public.billing_records;
DROP TRIGGER trg_billing_records_no_truncate ON public.billing_records;
DROP FUNCTION public.billing_records_immutable();
ALTER TABLE public.billing_records DROP COLUMN cq_fee_usd;
ALTER TABLE public.billing_records DROP COLUMN signed_hash;
