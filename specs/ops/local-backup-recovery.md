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

## Acceptance criteria

- **AC-1:** a simulated REST row cap still exports all 1,001 rows of a table;
  inconsistent counts or empty pages fail rather than produce a backup.
- **AC-2:** backup and restore ignore a project-local dotenv override fixture
  and use the passed process credentials.
- **AC-3:** local backup, deletion, restore, and final fixture cleanup pass for
  the scoped fact and audit records.
