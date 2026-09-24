# Stripe invoice amount gate

**Scope:** `plan.md` §9 invoice generation. Stripe's invoice-create endpoint
defaults to excluding pending invoice items when the behavior parameter is
omitted. A successful HTTP response alone does not prove that the intended
fee appears on the invoice.

## REQ-1 — Include the intended pending item

WHEN a pending invoice item for an organization and period has been created or
reused, THE STRIPE SINK SHALL request its inclusion when creating the draft
invoice. IF another pending item exists on that customer, THEN the sink SHALL
fail before creating an invoice because the include option would sweep it up.

## REQ-2 — Verify Stripe's amount

WHEN Stripe returns a draft invoice, THE STRIPE SINK SHALL verify its USD
currency, integer-cent total, and amount due equal the computed invoice fee
before finalizing it. IF any field is missing or differs, THEN it SHALL fail
without finalizing or reporting a successful receipt.

WHEN Stripe returns a finalized invoice, THE STRIPE SINK SHALL verify the same
fields and an open or paid status before reporting a successful receipt.

## REQ-3 — Describe the verified stage accurately

WHEN the test-mode verifier reports its result, IT SHALL describe invoice
finalization and local webhook routing as the verified actions. It SHALL NOT
claim that an email was delivered or a payment was made.

## Acceptance criteria

- The injected Stripe flow asserts `pending_invoice_items_behavior=include`.
- A pending item from another period prevents invoice creation.
- A draft total or amount due of zero or another value prevents finalization.
- Missing/mismatched finalized amount prevents a successful receipt.
- The existing billing tests and typecheck pass. No live Stripe key is needed
  for these offline checks; real test-mode acceptance remains open.
