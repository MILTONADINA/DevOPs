# Project-key access to organization usage

**Status**: implemented (amended 2026-10-03 by specs/ops/payment-removal.md REQ-1)
**Amended**: The payment paths and `/billing` shell were removed by
`specs/ops/payment-removal.md` REQ-1. The project-key 403 rule now covers only
`GET /v1/billing/summary` and `GET /v1/billing/records`.

**Scope:** The usage API exposes organization-wide token summaries and usage
records, including estimated USD savings. A project-bound key does not
represent authority to read every project's usage. This change does not alter
usage recording or rename the two retained `/v1/billing/*` paths.

## REQ-1 — Restrict organization usage reads

WHEN commercial authentication uses a project-bound API key, THE SYSTEM SHALL
return HTTP 403 from `GET /v1/billing/summary` and `GET /v1/billing/records`
before querying the usage source. Client query
parameters and headers SHALL NOT elevate the key to organization-level access.

WHEN commercial authentication uses an unbound organization API key, THE
SYSTEM SHALL preserve organization-scoped usage reads.
WHERE usage dependencies are supplied without authentication, THE SYSTEM
SHALL preserve the personal-mode `?org-id` fallback. The default personal-mode
entry point does not supply these dependencies.

## Acceptance criteria

- **AC-1:** A project-bound key receives 403 from both usage data paths,
  including attempts to supply an organization ID or empty project scope; no
  usage dependency is called.
- **AC-2:** An unbound commercial key can read the organization's usage summary
  and records. With usage dependencies explicitly supplied without auth, a
  personal-mode request can read them using `?org-id`.
