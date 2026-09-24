# Local organization backup and recovery

**Scope:** `plan.md` §7c and the approved local Compose development stack.

## REQ-1 — Process credentials

WHEN an operator runs organization backup or restore, THE SYSTEM SHALL read
the Supabase URL and service key only from the process environment. It SHALL
NOT load `.env` files. Local verification SHALL keep backup files inside the
project's ignored `stratum/backups/` directory and remove its fixture.

## REQ-2 — Complete export

WHEN a table has more rows than one REST page, THE SYSTEM SHALL fetch every
row in stable key order and SHALL fail instead of writing a partial backup if
the server's exact row count changes or a page is unexpectedly empty. It SHALL
page the session-scoped pruning log as well as organization-scoped tables.

## REQ-3 — Recovery check

WHEN local verification creates a disposable organization, session, fact,
audit status, and conflict, THE SYSTEM SHALL export them, delete those rows,
restore them through the CLI, and verify that IDs, fact suppression, audit
status, and conflict evidence survived. This local result SHALL NOT be treated
as a clean-machine or production recovery test.

## REQ-4 — Complete restore manifest

WHEN an operator restores an organization backup, THE SYSTEM SHALL reject a
snapshot that omits any table exported by the current backup command, contains
a non-array table, or names a table the restore command does not support. It
SHALL perform this check before either a dry-run success or a database write.
An explicitly empty table SHALL be valid. Older snapshots with a different
table set require an explicit migration before restore.

## REQ-5 — Organization-bound restore rows

WHEN an operator restores an organization backup, THE SYSTEM SHALL verify that
every organization-scoped row belongs to the backup organization and that every
pruning log names a session contained in the same backup. It SHALL reject a
cross-organization or orphaned row before either a dry-run success or a
database write.

## REQ-6 — Missing credentials fail recovery commands

WHEN an operator runs a backup or a non-dry-run restore without either
`SUPABASE_URL` or `SUPABASE_SERVICE_KEY` in the process environment, THE
SYSTEM SHALL exit nonzero and state that credentials are missing. A restore
dry run SHALL validate the file without requiring database credentials.

## REQ-7 — Local recovery runbook

WHEN an operator needs to back up or recover the local Stratum stack, THE
PROJECT SHALL provide a runbook with the exact supported commands, an
inspection step before restore, clean-target and secret-handling limits, and
the distinction between the disposable recovery check and real-data recovery.

## Acceptance criteria

- **AC-1:** a simulated REST row cap still exports all 1,001 rows of a table;
  inconsistent counts or empty pages fail rather than produce a backup.
- **AC-2:** backup and restore ignore a project-local dotenv override fixture
  and use the passed process credentials.
- **AC-3:** local backup, deletion, restore, and final fixture cleanup pass for
  the scoped fact and audit records.
- **AC-4:** a missing, malformed, or unknown table makes restore exit nonzero
  before any write; a current complete snapshot with empty tables succeeds.
- **AC-5:** a foreign organization row in any scoped table or a pruning log
  for a session outside the backup makes restore exit nonzero before any write.
- **AC-6:** backup and real restore return nonzero for each missing credential;
  a valid restore dry run still succeeds without credentials.
- **AC-7:** the runbook documents local startup, backup, dry run, clean-target
  restore, verification, and incident triage without claiming a real-data drill.
