# Stripe invoice retry lookup beyond the idempotency window

**Scope:** `plan.md` §9, Stripe invoice generation. Stripe may discard an
idempotency key after 24 hours. Once an invoice consumes its pending item, a
pending-item check cannot identify that invoice on a later retry.

## REQ-1 — Find an existing period invoice

WHEN resolving a Stripe customer for an organization and billing period, THE
STRIPE SINK SHALL scan that customer's invoice list with bounded pagination
before creating another invoice item. It SHALL match the exact organization,
period start, and period end metadata written on new invoices. IF exactly one
matching invoice exists with the expected USD total and amount due, THEN an
open or paid invoice SHALL be returned without any mutation, and a draft
invoice SHALL be finalized and returned without creating another invoice.

## REQ-2 — Fail closed on ambiguity

WHEN a matching invoice has a different/missing amount or currency, an
unsupported status, or more than one match, THE STRIPE SINK SHALL fail before
creating another item. It SHALL also fail on malformed/incomplete pagination
and on a legacy Stratum invoice for the organization whose period metadata is
missing, because it cannot rule out a prior bill for the requested period.

## Acceptance criteria

- An open invoice on page two returns its existing ID with no POST.
- A matching draft is finalized once and does not create another item.
- A mismatched, duplicate, or legacy untagged invoice prevents new creation.
- A nonadvancing invoice cursor prevents new creation.
- The existing Stripe billing file and typecheck pass. These injected-response
  tests do not establish real Stripe test-mode acceptance or concurrent retry
  safety.
