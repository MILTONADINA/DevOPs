# Local append-only billing ledger gate

**Scope:** `plan.md` §8, v0.9 billing schema ship gate. This verifies the
already-applied local PostgreSQL migration without retaining a billing row.

## REQ-1 — Reject ledger mutation

WHEN a billing record exists inside a disposable local database transaction,
THE DATABASE SHALL reject UPDATE, DELETE, and TRUNCATE with an explicit
append-only error, including an INSERT ... ON CONFLICT DO UPDATE attempt
and the database administrator role. The
generated token delta, cost delta, and CQ fee SHALL match their immutable
input columns. The verifier SHALL roll back all fixture rows.

## REQ-2 — Honest signature verification startup

WHEN the billing signature verifier is invoked, THE VERIFIER SHALL use only
explicit process environment credentials. It SHALL NOT load a `.env` file.
IF the database URL, service key, or dedicated signing secret is missing,
THEN it SHALL exit nonzero and state which setting is required. It SHALL NOT
report a skipped verification as success.

## REQ-3 — Verify every record

WHEN an organization has more billing records than one REST response can
contain, THE VERIFIER SHALL read stable ordered pages through the exact row
count and check each signature. IF the count is missing, changes during
paging, or a page stalls before the count, THEN verification SHALL fail rather
than report a partial ledger as valid.

## Acceptance criteria

- A PostgreSQL fixture transaction proves UPDATE, UPSERT, DELETE, and TRUNCATE raise, checks
  generated values, and rolls back the organization, session, and billing row.
- The same fixture proves a billing row prevents deletion of its referenced
  session, making the open erasure-schema dependency explicit.
- A focused test first fails on the current zero-exit skip, then proves
  missing credentials and signing secret yield nonzero status without a DB
  connection.
- A capped fake REST client puts a bad signature after record 1,000; the
  verifier finds it and refuses missing counts or incomplete pages.
