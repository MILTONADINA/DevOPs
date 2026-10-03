# Scoped session erasure

**Status**: approved

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` REQ-8/9.
C4-A moves this spec out of `specs/billing/`, retires the invoice schema and
financial preflight blocker, and supersedes ADR-0021. The deletion endpoint and
one-year performance acceptance remain unfinished; this is not an implemented
erasure specification.

**Scope:** `plan.md` §8 and `runtime/docs/SECURITY.md` §GDPR Erasure. A
customer may request deletion of one session's content. Unsigned usage rows
remain ordinary session-linked data with organization/session foreign keys.
ADR-0025 and payment-removal REQ-8 supersede the former financial premise;
the inventory, ownership and deletion gates below remain required.

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
blocked status with distinct ambiguous-graph, uninventoried-store, and
unavailable-execution reasons as applicable. It SHALL NOT report a financial
retention blocker because usage rows exist. It SHALL return 404 for a foreign,
missing, or internal usage session and deny project-bound keys. It SHALL NOT
delete data or claim erasure is ready while external copies, backups, or RAM
remain uninventoried or erasure execution is unavailable.

## REQ-2 — Usage is ordinary session-linked data

WHEN an authorized session erasure executes, THE SYSTEM SHALL delete that
session's usage rows in `billing_records` as ordinary session-linked data
within the transaction required by REQ-3. The inventory SHALL continue to
report a numeric `billing_records` count, including zero. Usage rows SHALL NOT
create a billing-retention blocker. Any data retained for another applicable
reason SHALL be identified in the response and excluded from ordinary memory
recall; replacing a linkable identifier SHALL NOT be described as anonymization.

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
erase the target, session-linked usage is deleted without a financial blocker,
a shared graph entity survives, and all session-owned content is gone. The
check SHALL invoke an actual authenticated erasure API and verify the database
afterward. A read-only preflight or end-session response SHALL NOT satisfy
this requirement or payment-removal AC-8. The v0.9 release gate SHALL
measure end-to-end erasure of a representative one-year session history in
under 30 seconds and record the fixture size, command, elapsed time, and
remaining rows. A small fixture alone SHALL NOT satisfy that gate.

## Acceptance status

- C4-A/M2 retires both invoice RPCs and both invoice tables, removes their
  organization-only inventory entries, and removes the financial preflight
  blocker. `billing_records` and its numeric count remain. These changes do
  not implement erasure or satisfy the actual-API part of payment-removal AC-8.
- The current preflight remains `blocked_incomplete_inventory`, including
  `erasure_execution_unavailable` and applicable graph/store reasons.
  `DELETE /v1/sessions/:id` only sets `ended_at`; it does not erase data.
- Actual API erasure, complete RAM/external/backup coverage and the
  representative one-year/<30-second benchmark remain unfinished.
- The local inventory now reports linked graph rows and provenance uncertainty;
  disposable two-session promotion and backup/restore checks cover recorded
  links. A clean-target recovery check preserves File-to-fact source link IDs
  and an explicitly empty link snapshot. Untagged legacy graph, RAM, external
  copies and backup deletion remain unresolved.
