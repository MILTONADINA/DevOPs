# Local unsigned usage ledger gate

**Status**: approved (retained unsigned usage contract; payment-removal C3, owner decision 2026-09-26)

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md`: C2 REQ-4 replaces the mutation/signature gate with unsigned mutable usage. C3 REQ-7 removes the legacy verification CLI and retires only its requirements and acceptance criteria below.

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

## REQ-2 — Retired signature verification startup

Superseded by payment-removal REQ-4/5/7 and ADR-0025. The signature verifier
and its missing-signing-secret startup tests are removed with C3. The current
team-mode database and durable-journal guards remain in
`commercial-fail-closed.md`; startup needs no signing secret.

## REQ-3 — Retired signature verification pagination

Superseded with the signature verifier by payment-removal REQ-7 and ADR-0025.
Complete current usage-summary pagination remains required by
`invoice-full-read.md` REQ-2, including missing/changing counts and stalled
pages. Unsigned replay integrity remains in `usage-event-idempotency.md`.

## Acceptance criteria

- A PostgreSQL fixture transaction proves unsigned insert, exact generated
  token/estimated-cost values, allowed UPDATE/DELETE, preserved event uniqueness
  and absent mutation guards/retired columns, then rolls back all fixture rows.
- The same fixture proves a billing row prevents deletion of its referenced
  session, making the open erasure-schema dependency explicit.

**Verified by:** `runtime/test/integration/local-billing-ledger.sql`. The
session foreign-key/erasure dependency remains until the coordinated C4 work;
C3 does not change schema or remove that SQL acceptance check.
