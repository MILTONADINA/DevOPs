# Complete billing invoice reads

**Scope:** `plan.md` §8–9, existing CFO invoice and summary paths.

## REQ-1 — Fail when credentials are absent

WHEN the invoice CLI is invoked with a valid organization ID, THE CLI SHALL
use only explicit process environment credentials. It SHALL NOT load `.env`.
IF the database URL or service key is missing, THEN it SHALL exit nonzero and
name the missing setting before any database request or Stripe delivery.

## REQ-2 — Read every billing row

WHEN the CFO invoice, CSV, summary, or CLI reads an organization's billing
records, THE SERVICE SHALL page in stable ID order through the exact row count.
IF the count is unavailable, changes during paging, or a page ends before the
count, THEN the service SHALL fail instead of reporting a partial financial
total. Date bounds and organization scope SHALL apply to every page.

## Acceptance criteria

- A focused CLI test proves missing credentials return nonzero.
- A capped fake REST response with 1,001 rows produces all 1,001 records,
  preserving scope and date bounds on each page, and the developer summary
  accounts for all rows.
- Missing, changed, and incomplete count cases fail closed.
