# Local unsigned usage ledger gate

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` C2: REQ-4 replaces the mutation/signature gate with unsigned mutable usage. The old verification CLI source remains until C3 but cannot process the post-M1 schema.

**Scope:** Local PostgreSQL usage schema verification after C2/M1, without
retaining fixture rows. The table name stays `billing_records`.

## REQ-1 — Unsigned mutable usage with exact derived values

WHEN a usage record exists inside a disposable local database transaction,
THE DATABASE SHALL accept an unsigned insert and allow scoped UPDATE and DELETE.
The generated token delta and estimated USD cost delta SHALL match their input
columns. The fee/signature columns and mutation-blocking triggers/function
SHALL be absent; RLS, the session foreign key and unique usage-event index
SHALL remain. The verifier SHALL roll back all fixture rows and SHALL NOT
truncate a shared table to prove trigger absence.

## REQ-2 — Legacy signature verification startup

This requirement describes the retained pre-M1 CLI only; it is superseded for
current usage by payment-removal REQ-4 and removed with its CLI in C3.

WHEN the billing signature verifier is invoked, THE VERIFIER SHALL use only
explicit process environment credentials. It SHALL NOT load a `.env` file.
IF the database URL, service key, or dedicated signing secret is missing,
THEN it SHALL exit nonzero and state which setting is required. It SHALL NOT
report a skipped verification as success.

## REQ-3 — Legacy verification pagination

This requirement describes the retained pre-M1 CLI only. Current usage summary
pagination remains covered by `invoice-full-read.md` REQ-2.

WHEN an organization has more billing records than one REST response can
contain, THE VERIFIER SHALL read stable ordered pages through the exact row
count and check each signature. IF the count is missing, changes during
paging, or a page stalls before the count, THEN verification SHALL fail rather
than report a partial ledger as valid.

## Acceptance criteria

- A PostgreSQL fixture transaction proves unsigned insert, exact generated
  token/estimated-cost values, allowed UPDATE/DELETE, preserved event uniqueness
  and absent mutation guards/retired columns, then rolls back all fixture rows.
- The same fixture proves a billing row prevents deletion of its referenced
  session, making the open erasure-schema dependency explicit.
- Retained legacy CLI unit tests prove missing credentials and signing secret
  yield nonzero status without a DB connection.
- A retained legacy fake REST test puts a bad signature after record 1,000; the
  verifier finds it and refuses missing counts or incomplete pages.

Legacy CLI unit assertions do not prove compatibility with the post-M1 database.
