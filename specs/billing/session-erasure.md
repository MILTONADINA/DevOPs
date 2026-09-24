# Session erasure and billing retention boundary

**Scope:** `plan.md` §8 and `stratum/docs/SECURITY.md` §GDPR Erasure. A
customer may request deletion of one session's content. The existing signed
billing ledger is immutable and directly references the session and
organization. This spec defines the required end state; a policy decision on
retaining financial rows remains open.

## REQ-1 — Scoped, complete session inventory

WHEN a session erasure is requested, THE SYSTEM SHALL resolve the session by
both authenticated organization ID and session ID. It SHALL inventory every
persisted row tied to the session, including typed facts, audit evidence,
pruning logs, vectors, graph entities and edges, source links, billing records,
and any external copy or backup. It SHALL distinguish session-owned graph rows
from graph rows reused by another session. A missing or ambiguous owner SHALL
fail closed rather than silently leave or delete content.

## REQ-2 — Ledger invariant and retention decision

WHILE billing records remain append-only and signed over their original
organization/session IDs, THE SYSTEM SHALL NOT rewrite or delete those rows or
claim that replacing their IDs anonymizes them. IF a session has billing rows,
THEN completion SHALL require a documented applicable retention decision and
a technical boundary that either lawfully retains only necessary financial
data or permits erasure without violating the ledger invariant. An absent
decision SHALL block completion with a distinct status. Any retained data
SHALL be identified in the response and excluded from ordinary memory recall.

## REQ-3 — Atomic content deletion and reuse safety

WHEN an authorized, policy-cleared session erasure executes, THE SYSTEM SHALL
delete all session-owned content and its vector/source/audit derivatives within
one database transaction. It SHALL invalidate in-memory session content and
prevent new writes for that session before reporting success. It SHALL preserve
other organizations' rows and shared graph entities still referenced by other
sessions. IF any required store fails, THEN it SHALL report an incomplete
erasure and retain a retryable record; it SHALL NOT return a success response.

## REQ-4 — Verifiable completion and performance

WHEN an erasure reports success, THE SYSTEM SHALL return a timestamp and a
machine-checkable inventory of deleted and legally retained data classes. A
local integration check SHALL prove a foreign-organization request cannot
erase the target, a billed session cannot bypass REQ-2, a shared graph entity
survives, and all session-owned content is gone. The v0.9 release gate SHALL
measure end-to-end erasure of a representative one-year session history in
under 30 seconds and record the fixture size, command, elapsed time, and
remaining rows. A small fixture alone SHALL NOT satisfy that gate.

## Acceptance status

- The current schema fails REQ-2 for a billed session: append-only billing
  rows reference the session and organization; deleting either is blocked.
- The live local foreign-key inventory and existing ledger fixture establish
  this blocker. No erasure endpoint or one-year performance result is claimed.
