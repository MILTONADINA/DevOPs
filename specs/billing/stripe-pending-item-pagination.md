# Complete Stripe pending-item retry check

**Scope:** `plan.md` §9 v1.0 invoice sending. Stripe's list endpoint returns
at most 100 invoice items per page and an explicit `has_more` cursor signal.
Idempotency keys may be removed after 24 hours, so the org/period metadata
check must inspect every pending page before a retry creates another item.

## REQ-1 — Scan every pending page before creation

WHEN sending an invoice for an organization and period, THE STRIPE SINK SHALL
page through that customer's pending invoice items using `starting_after`
until it finds matching org/period metadata or Stripe reports `has_more=false`.
IF it finds a match on any page and no other pending items, THEN it SHALL
reuse the item and SHALL NOT create another invoice item. IF unrelated pending
items exist, THEN it SHALL fail before invoice creation under
`specs/billing/stripe-invoice-amount-gate.md#req-1`.

## REQ-2 — Fail closed on incomplete pagination

WHEN a pending-item page is malformed, `has_more=true` lacks a valid new
cursor, a cursor repeats, or the bounded scan is exhausted, THE STRIPE SINK
SHALL fail before any invoice item or invoice is created. It SHALL NOT treat
an incomplete scan as proof that no matching item exists.

## REQ-3 — Reuse only the same charge

WHEN a pending item matches the organization and period, THE STRIPE SINK SHALL
verify its currency is USD and its integer-cent amount equals the current
invoice amount before reuse. IF either value is missing or different, THEN it
SHALL fail before creating or finalizing an invoice, so a changed bill cannot
silently reuse a stale pending charge.

## Acceptance criteria

- An injected Stripe test places 100 nonmatching items on page one and a
  matching org/period item on page two; the scan reaches page two, then rejects
  before any POST because the unrelated items would be swept into the invoice.
- Malformed or nonadvancing pagination rejects before any invoice-item POST.
- A matching org/period item with a different amount rejects before invoice creation.
- Existing dollar-to-cent, live-key refusal, and invoice flow tests pass.
- No live Stripe request is required for these offline checks.
