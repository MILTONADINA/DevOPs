# Inspect a held invoice claim without sending

**Scope:** `plan.md` §9 commercial invoice recovery; follows
`specs/billing/invoice-send-claim.md` REQ-2.

## REQ-1 — Bound read-only inspection

WHEN an operator invokes `invoice --inspect-claim`, THE CLI SHALL require an
organization, increasing period bounds, a Stripe test-mode key, and an existing
durable claim. It SHALL reject `--send`, `--reconcile`, `--csv`, and `--force` combinations
before any database or Stripe access. It SHALL NOT create Stripe or local rows,
finalize an invoice, or clear the claim.

## REQ-2 — Report evidence without declaring absence

WHEN the claim exists, THE INSPECTOR SHALL search all matching customers and
list their invoices and pending invoice items with bounded pagination. It SHALL
report exact org/period matches and their IDs/status, and fail on mismatched
amounts, duplicates, malformed pages, or incomplete pagination. IF no match is
found, THEN it SHALL say the lookup is inconclusive and keep the claim held:
Stripe customer search is eventually consistent.

## Acceptance criteria

- Fake Stripe calls prove inspection performs only GET requests and finds an
  invoice on a later customer/search page.
- Missing claim prevents any Stripe call; zero matches never clear a claim.
- CLI preflight rejects invalid combinations, period, or test key before DB.
