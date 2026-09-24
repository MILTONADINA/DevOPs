# Project-key access to organization controls

**Scope:** Protect shared organization configuration and its test webhook
delivery after project-bound API keys were introduced. Configuration remains
an organization-level resource; this change does not create per-project
configuration or change message forwarding.

## REQ-1 — Restrict organization-level actions

WHEN commercial authentication uses a project-bound API key, THE SYSTEM SHALL
reject `PATCH /v1/config` and `POST /v1/webhooks/test` with HTTP 403 before
reading webhook configuration, changing organization configuration, or sending
a webhook. A query parameter, header, or request body SHALL NOT promote a
project-bound key to an organization-level key.

WHEN an unbound commercial API key or personal-mode request uses these routes,
THE SYSTEM SHALL retain existing organization-scoped behavior and validation.
`GET /v1/config` SHALL remain readable to an authenticated project key so the
shared non-secret runtime settings remain visible.

## Acceptance criteria

- **AC-1:** red/green route tests prove bound keys receive 403 and neither
  storage nor delivery dependency runs, including spoofed scope fields.
- **AC-2:** unbound commercial and personal requests retain successful config
  updates and test webhook delivery; bound GET still omits the webhook secret.
