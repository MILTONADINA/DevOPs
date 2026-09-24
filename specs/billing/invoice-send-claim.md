# Durable invoice send claim

**Scope:** `plan.md` §9 first commercial invoice. The existing `invoices`
unique index is written only after Stripe finalization and cannot prevent two
concurrent CLI processes from both crossing the provider boundary.

## REQ-1 — Bound every send

WHEN the invoice CLI receives `--send`, IT SHALL require both `--since` and
`--until` as a valid increasing billing period before reading billing rows or
calling Stripe. It SHALL reject `--force`, which cannot safely bypass the
Stripe-side exact-period retry lookup. It SHALL require a Stripe test-mode key
before taking a claim. Read-only report and CSV modes SHALL continue to
support unbounded ranges.

## REQ-2 — Claim before calling Stripe

WHEN a bounded invoice has a positive amount and no active local invoice,
THE RUNNER SHALL atomically insert a durable claim keyed by organization and
period before any Stripe request. IF that claim already exists or its insert
fails, THEN it SHALL refuse the send before the provider call. Claims SHALL
remain after success or an ambiguous provider error; only an operator who has
reconciled Stripe and the local invoice ledger may clear one.

## REQ-3 — Report ledger failure

WHEN Stripe finalizes an invoice but the local sent-invoice ledger write fails,
THE RUNNER SHALL return nonzero and name the invoice ID so the operator can
reconcile it. It SHALL NOT describe the action as delivered email or payment.

## Acceptance criteria

- A migration establishes a service-only table with a unique organization and
  period key; two concurrent inserts for one key produce one winner.
- A focused fake-ledger test proves the second claim refuses before Stripe.
- CLI tests prove `--send` rejects missing bounds, `--force`, and a missing
  test key before any DB or Stripe request; unbounded report mode remains
  accepted.
- A provider-success/local-ledger-failure test returns nonzero and retains the
  claim. Real Stripe acceptance and email delivery remain separate gates.
