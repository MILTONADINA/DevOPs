# Reconcile a claimed Stripe invoice without another charge

**Scope:** `plan.md` §9 commercial invoice recovery. The durable claim blocks
another send after an ambiguous provider or local-ledger failure. An operator
needs a verified way to record an already-finalized invoice by its Stripe ID.

## REQ-1 — Require the held claim and bounded identity

WHEN `invoice --reconcile <stripe-invoice-id>` is invoked, THE CLI SHALL
require an organization, valid increasing `--since`/`--until` bounds, a
test-mode Stripe key, and an existing durable claim for that exact period.
It SHALL reject combination with `--send` or `--force`. It SHALL NOT create,
finalize, send, or delete a Stripe invoice or clear the claim.

## REQ-2 — Verify Stripe before local recovery

WHEN reconciling the named invoice, THE SINK SHALL retrieve it by ID and
verify the returned ID, object type, org/period metadata, USD currency,
integer-cent total and amount due against the recomputed local invoice. It
SHALL accept only an open or paid status. A paid invoice SHALL have a valid
paid timestamp. IF any check fails, THEN no local invoice row SHALL be added.

## REQ-3 — Persist without losing paid state

WHEN the claim and Stripe invoice verify, THE LEDGER SHALL insert a missing
local row for the period or atomically attach that period to a same-ID row
created earlier by the payment webhook. It SHALL preserve verified paid state
and move a same-ID sent row to paid when Stripe verifies payment. IF the local
period has a different invoice ID, the same-ID row belongs to another
organization or period, or a paid row would be downgraded, THEN it SHALL
fail. The durable claim SHALL remain in all cases to prevent a later
duplicate send.

## Acceptance criteria

- A fake Stripe GET proves exact identity, amount, and state checks, with zero
  POSTs, and rejects wrong metadata, amount, draft, or missing paid timestamp.
- A fake ledger proves missing claim and conflicting ID fail before write;
  verified paid status records its paid timestamp and same-ID replay is safe.
- A local PostgreSQL transaction proves a prior paid webhook row with a NULL
  period gains the verified period without losing paid status; foreign-org,
  different-period, duplicate period, and paid-to-sent attempts fail.
- CLI preflight rejects missing bounds, missing test key, `--send` and
  `--force` combinations before database or Stripe access.
- A local PostgreSQL transaction verifies a service-role reconciliation row
  fits the existing unique period index; no live Stripe call is required.
