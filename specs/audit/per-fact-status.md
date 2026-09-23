# Persisted per-fact audit status

**Scope:** `plan.md` §5c dashboard badges and deterministic v0.6 Tier 1 audit.
The engine's `UNVERIFIED` name is used for the roadmap's `UNVERIFIABLE` badge.

## REQ-1 — Audited outcome

WHEN a trusted organization audits a persisted typed fact, THE SYSTEM SHALL
store its latest `CONFIRMED`, `UNVERIFIED`, or `CONFLICT` outcome with the fact
table, fact ID, audit time, and available evidence. It SHALL validate the
fact's organization and table in the database. A missing or foreign fact
SHALL fail the batch without partial writes.

WHEN the outcome is `CONFLICT`, THE SYSTEM SHALL suppress the fact, update
its audit status, and insert its Historical Drift evidence in one transaction.
Replaying identical evidence SHALL preserve an alert's acknowledgement. A
subsequent non-conflict audit SHALL NOT clear an existing suppression or
replace its `CONFLICT` status without explicit correction of the fact.

## REQ-2 — Scoped status surface

WHEN the protected memory API lists audit statuses, THE SYSTEM SHALL return
only the authenticated organization's latest rows. WHEN the dashboard has an
authorized scope, it SHALL show these rows with text-only status badges.
Unaudited or manually suppressed facts SHALL NOT be inferred to be
`UNVERIFIED` or `CONFLICT` merely from their boolean flags.

## REQ-3 — Org backup

WHEN an organization backup and restore includes audited facts, THE SYSTEM
SHALL export that organization's status rows and restore them after the owning
organization and fact rows.

## Acceptance criteria

- **AC-1:** a PostgreSQL transaction records all three outcomes, rejects a
  missing or foreign fact, and rolls back all rows on error.
- **AC-2:** conflict replay preserves acknowledgement; a later non-conflict
  result does not downgrade a suppressed conflict.
- **AC-3:** API reads use the trusted org, never a client-supplied override in
  commercial mode.
- **AC-4:** the dashboard renders status rows as text and does not request
  them before a key or personal-mode org is supplied.
- **AC-5:** backup and restore include `audit_statuses` in dependency order.
