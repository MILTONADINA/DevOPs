# Complete organization usage reads

**Status**: approved (retained usage contract; payment-removal C3, owner decision 2026-09-26)

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md`: C1 removed the CFO
invoice and CSV HTTP paths; C3 removes the invoice CLI and retires its REQ-1
and acceptance criterion. REQ-2 remains the complete-read contract for the
usage summary in `runtime/src/proxy/routes/usage.ts`. USD figures remain
estimates under payment-removal REQ-6.

**Scope:** Complete reads for organization usage summaries.

## REQ-1 — Retired invoice CLI credential guard

Superseded with the deleted invoice CLI by `specs/ops/payment-removal.md`
REQ-7 and ADR-0025. This is not a current usage API requirement. Other
commands' process-environment boundaries remain governed by their own specs.

## REQ-2 — Read every billing row

WHEN the usage summary reads an organization's billing
records, THE SERVICE SHALL page in stable ID order through the exact row count.
IF the count is unavailable, changes during paging, or a page ends before the
count, THEN the service SHALL fail instead of reporting a partial
total. Date bounds and organization scope SHALL apply to every page.

## Acceptance criteria

- A capped fake REST response with 1,001 rows produces all 1,001 records,
  preserving scope and date bounds on each page, and the developer summary
  accounts for all rows.
- Missing, changed, and incomplete count cases fail closed.

**Verified by:** `runtime/test/proxy/usage-deps-read.test.ts` and
`runtime/test/proxy/usage-route.test.ts`; invoice-only tests retire with C3.
