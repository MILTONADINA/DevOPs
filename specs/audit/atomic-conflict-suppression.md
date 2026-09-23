# Atomic Historical Drift suppression

**Scope:** v0.6 deterministic audit persistence, following
`specs/audit/conflict-idempotency.md` and `stratum/docs/AUDIT_ENGINE.md`.

## REQ-1 — One transaction

WHEN a trusted audit records a `CONFLICT` for a persisted typed fact, THE
SYSTEM SHALL set that fact's `is_suppressed` flag and insert its
`audit_conflicts` evidence in one database transaction. WHEN any row fails,
THE SYSTEM SHALL roll back all writes for that call and report the error.

## REQ-2 — Scope and replay

WHEN a conflict references a missing fact, a fact owned by another
organization, or a non-fact table, THE SYSTEM SHALL reject the call. WHEN
the same evidence is replayed, THE SYSTEM SHALL preserve the existing
acknowledgement and return zero newly inserted alerts; suppression SHALL
remain true.

## Acceptance criteria

- **AC-1:** the database RPC validates the table allowlist and updates only
  the specified organization's fact row before inserting its alert.
- **AC-2:** a missing or cross-organization fact raises, leaving no alert.
- **AC-3:** an insert failure rolls back the fact update and earlier rows.
- **AC-4:** duplicate evidence preserves acknowledgement and adds no alert.
