# Project-key access to organization billing

**Scope:** The billing API computes organization-wide invoices and summaries,
and exposes the organization's immutable financial ledger. A project-bound key
does not represent authority to read every project's financial data. This
change does not create project invoices or alter usage recording.

## REQ-1 — Restrict organization billing reads

WHEN commercial authentication uses a project-bound API key, THE SYSTEM SHALL
return HTTP 403 from `GET /v1/billing/summary`, `invoice`, `records`,
`invoices`, and `audit.csv` before querying the billing source. Client query
parameters and headers SHALL NOT elevate the key to organization-level access.

WHEN commercial authentication uses an unbound organization API key, or when
the proxy runs in personal mode, THE SYSTEM SHALL preserve existing billing
read behavior. The public `/billing` HTML shell SHALL remain available; its
data requests still require an authorized key in commercial mode.

## Acceptance criteria

- **AC-1:** A project-bound key receives 403 from all five billing data paths,
  including attempts to supply an organization ID or empty project scope; no
  billing dependency is called.
- **AC-2:** An unbound commercial key and personal-mode request can read the
  existing invoice and ledger responses; the HTML shell still loads.
