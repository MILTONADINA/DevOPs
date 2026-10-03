# Session erasure and billing retention boundary

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` C2: M1 removes usage signatures and mutation-blocking triggers. The existing API retention blocker and invoice inventory stay through C2; payment-removal REQ-8 removes them as applicable in C4, which also moves this spec and supersedes ADR-0021.

**Scope:** `plan.md` §8 and `runtime/docs/SECURITY.md` §GDPR Erasure. A
customer may request deletion of one session's content. Usage rows still
reference the session and organization after C2. The former financial premise
is superseded by the approved no-payment decision; C4 must remove the erasure
retention blocker without weakening the inventory, ownership or deletion gates.

## REQ-1 — Scoped, complete session inventory

WHEN a session erasure is requested, THE SYSTEM SHALL resolve the session by
both authenticated organization ID and session ID. It SHALL inventory every
persisted row tied to the session, including typed facts, audit evidence,
pruning logs, vectors, graph entities and edges, source links, billing records,
and any external copy or backup. It SHALL distinguish session-owned graph rows
from graph rows reused by another session. A missing or ambiguous owner SHALL
fail closed rather than silently leave or delete content.

### REQ-1a — Graph provenance across reuse

WHEN a graph entity or edge is created with a trusted session ID, THE DATABASE
SHALL record that session as a source in the same transaction. WHEN the graph
adapter reuses an existing entity or edge for another trusted session, IT
SHALL record the second session before reporting success. Provenance links
SHALL enforce same-organization entity/edge/session references. Existing rows
whose complete source history cannot be proved SHALL remain marked uncertain;
adding a new link SHALL NOT retroactively make them exclusive. The session
promoter SHALL pass each database-loaded fact's trusted session ID to graph
and vector promotion, including when a batch spans several sessions. The
inventory SHALL include entities and edges linked through provenance even
when their original `session_id` differs, and SHALL distinguish uncertain,
shared and exclusive graph ownership without deleting any row.
An organization backup and restore SHALL preserve all recorded session links
so a recovered inventory cannot misclassify a shared graph row.

### REQ-1b — Source-link recovery fidelity

WHEN an organization with indexed File-to-fact links is backed up and restored
to a clean target, THE SYSTEM SHALL export every scoped source link and restore
its original ID and timestamp. It SHALL replace links recreated by File/fact
insert triggers with the backed-up rows, so the recovered inventory and source
view reflect the original snapshot.

### REQ-1c — Read-only customer preflight

WHEN an organization-level authenticated key requests an explicit session's
erasure preflight, THE API SHALL return the scoped database inventory and a
blocked status with distinct billing-retention, ambiguous-graph, and
uninventoried-store reasons as applicable. It SHALL return 404 for a foreign,
missing, or internal usage session and deny project-bound keys. It SHALL NOT
delete data or claim erasure is ready while external copies, backups, or RAM
remain uninventoried.

## REQ-2 — Ledger invariant and retention decision (pre-C2 requirement)

The following historical requirement no longer describes the M1 schema. Its
existing API blocker remains until the coordinated C4 erasure change; do not
claim erasure complete from removal of mutation triggers alone.

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

- C2 removes usage-row signatures and mutation guards, but keeps the session
  foreign key, invoice tables and existing read-only erasure preflight blocker.
  C4 must update this boundary under payment-removal REQ-8; C2 alone does not
  establish a working erasure endpoint or a one-year performance result.
- The local inventory now reports linked graph rows and provenance uncertainty;
  disposable two-session promotion and backup/restore checks cover recorded
  links. A clean-target recovery check preserves File-to-fact source link IDs
  and an explicitly empty link snapshot. Untagged legacy graph, RAM, external
  copies and backup deletion remain unresolved.
