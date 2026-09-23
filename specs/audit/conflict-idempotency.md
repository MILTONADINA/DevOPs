# Idempotent Historical Drift records

**Scope:** v0.6 audit conflict persistence; `plan.md` §5c and
`stratum/docs/AUDIT_ENGINE.md` Historical Drift Alerts.

## REQ-1 — Repeat audits

WHEN the same organization audits the same fact against the same contradictory
commit and detail again, THE SYSTEM SHALL retain one `audit_conflicts` record.
It SHALL preserve the existing record's acknowledgement state and timestamp.

## REQ-2 — Distinct evidence

WHEN a new contradictory commit or detail is found for that fact, THE SYSTEM
SHALL record a separate conflict. WHEN another organization audits the same
fact identifier, THE SYSTEM SHALL keep its conflict record separate.

## Acceptance criteria

- **AC-1:** re-running conflict persistence leaves one row and does not reset an
  acknowledged record.
- **AC-2:** a different commit, detail, or organization creates a distinct row.
- **AC-3:** write errors remain visible to the caller.
