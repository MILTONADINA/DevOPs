# Complete billing invoice reads

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` REQ-1: the CFO invoice
and CSV HTTP paths were removed. REQ-2 now covers the usage summary served by
`runtime/src/proxy/routes/usage.ts` and the invoice CLI, which remains until C3.

**Scope:** Complete reads for organization usage summaries and the retained
invoice CLI.

## REQ-1 — Fail when credentials are absent

WHEN the invoice CLI is invoked with a valid organization ID, THE CLI SHALL
use only explicit process environment credentials. It SHALL NOT load `.env`.
IF the database URL or service key is missing, THEN it SHALL exit nonzero and
name the missing setting before any database request or Stripe delivery.

## REQ-2 — Read every billing row

WHEN the usage summary or invoice CLI reads an organization's billing
records, THE SERVICE SHALL page in stable ID order through the exact row count.
IF the count is unavailable, changes during paging, or a page ends before the
count, THEN the service SHALL fail instead of reporting a partial
total. Date bounds and organization scope SHALL apply to every page.

## Acceptance criteria

- A focused CLI test proves missing credentials return nonzero.
- A capped fake REST response with 1,001 rows produces all 1,001 records,
  preserving scope and date bounds on each page, and the developer summary
  accounts for all rows.
- Missing, changed, and incomplete count cases fail closed.
