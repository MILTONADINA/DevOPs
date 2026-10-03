# Backup and restore

This runbook explains what the organization backup and restore scripts cover,
how to check a backup file, what the disposable recovery check proves, and
where the limits are. The step-by-step commands for a backup and a restore are
in [LOCAL_STRATUM.md](LOCAL_STRATUM.md#back-up-one-organization) and
[LOCAL_STRATUM.md](LOCAL_STRATUM.md#restore-into-a-clean-target). Follow those
steps; this page does not repeat them.

Both scripts target the project-local Compose stack. The hosted Supabase
project is retired
(`runtime/docs/decisions/0020-local-storage-after-hosted-retirement.md`).

## The two scripts

| Script | npm script (from `runtime/`) | Writes to the database |
| --- | --- | --- |
| `runtime/scripts/backup-org.ts` | `npm run backup -- --org-id <uuid> [--out <path>] [--pretty]` | No. It only reads. |
| `runtime/scripts/restore-org.ts` | `npm run restore -- --file <path> [--dry-run] [--keep-key-state]` | Yes, unless `--dry-run` is given. |

Both read `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the process
environment, so run them through `npm run db:with-env -- ...`. A dry-run
restore needs neither, because it returns before reading them.

Sources: `runtime/package.json:47-48`, `runtime/scripts/backup-org.ts`,
`runtime/scripts/restore-org.ts`.

## What a backup contains

A backup is one JSON object with three keys: `orgId`, `exportedAt`, and
`tables`. `tables` maps each table name to an array of rows. The file holds
21 tables:

- `organizations`, selected by `id`.
- These 19 tables, selected by `org_id`: `developers`, `org_config`,
  `sessions`, `billing_records`, `function_changes`,
  `tech_decisions`, `policy_updates`, `todos`, `variable_changes`,
  `operational_references`, `knowledge_entities`, `knowledge_edges`,
  `knowledge_entity_sessions`, `knowledge_edge_sessions`,
  `source_fact_links`, `memory_vectors`, `audit_conflicts`,
  `audit_statuses`, `api_keys`.
- `pruning_logs`, selected through the organization's session IDs in batches
  of 100, because that table has no `org_id`.

Each table is read in pages of 500 rows with an exact row count. The export
fails if the count is unavailable, changes between pages, or does not match
the rows received. It never writes a partial file on a read error. If no
organization row matches, it writes nothing and exits 1.

With no `--out`, the file goes to `backups/stratum-backup-<first 8 chars of
org id>-<timestamp>.backup.json` under the current directory. Run it from
`runtime/`, where `backups/` is ignored by Git. The script writes the file
with default permissions, which is why the LOCAL_STRATUM procedure sets
`umask 077` first.

The file holds organization data, including `api_keys` rows with their key
hashes and `billing_records`. Treat it as sensitive.

Sources: `runtime/scripts/backup-org.ts`, `runtime/.gitignore:71-72`,
`runtime/src/proxy/auth.ts:33-42`, `docs/runbooks/LOCAL_STRATUM.md:62-67`.

## What a backup does not contain

- **Files on disk.** The proxy keeps billing usage events in a local outbox
  directory (default `runtime/data/usage-outbox/`) and reads captured sessions
  from `runtime/data/sessions/`. The encoder model cache is
  `runtime/models/`. None of these are in the backup. Events still in the
  outbox are not yet in `billing_records`, so they are not in the backup
  either.
- **The database volume, other organizations, and schema state.** This is a
  logical export of one organization, not a PostgreSQL volume backup. It does
  not record which migrations were applied (`devops_local.migrations`).
- **A consistent point in time.** Tables are read one after another, so the
  file is not an atomic cross-table snapshot.

Sources: `runtime/src/usage/durable-usage-outbox.ts`,
`runtime/scripts/backup-org.ts`,
`runtime/scripts/restore-org.ts`, `runtime/src/proxy/index.ts:450-451`,
`runtime/src/proxy/index.ts:504`, `runtime/.gitignore:43-49`,
`runtime/scripts/local-compose.ts:113`, `docs/runbooks/LOCAL_STRATUM.md:75-78`.

## Verify a backup

1. Require exit code 0 and the final summary line from the backup command:
   `<N> row(s) across <M> tables → <path>`. `M` is 21 after C4-A/M2.
2. Confirm the file at that path exists and is not empty.
3. Validate the file without writing anything:

   ```sh
   npm run restore -- --file backups/org.backup.json --dry-run
   ```

   The dry run applies every structural check that a real restore applies,
   prints the per-table insert plan, and ends with
   `DRY RUN — would insert <N> row(s) across <K> tables. Nothing written.`
   `K` counts only non-empty tables.

The dry run checks the file only. It rejects:

- a missing or empty `orgId`, or an `organizations` array that is not exactly
  one row with that ID;
- a missing active table, or a table name other than the active manifest and
  the two explicitly retired invoice tables;
- a file without `operational_references` (an export from before that table
  existed);
- any malformed retired-table container/row, or an organization-scoped row
  (including a legacy invoice row) whose `org_id` differs from `orgId`;
- decision supersession links that are missing, duplicated, cross-project,
  not newer than the decision they replace, or lack a reviewer, at least 20
  characters of evidence, and a review time;
- conversation sessions whose API key is not in the file, and `pruning_logs`
  rows whose session is not in the file.

Either retired table may be absent. If `invoices` or `invoice_send_claims`
is present as a valid row array, restore skips it and prints its name and row
count, including zero for an empty array. It never queries or inserts a
retired table. This applies to dry and real restores.

The dry run does not prove that foreign keys or all inserts will succeed on a target
(`docs/runbooks/LOCAL_STRATUM.md:102-104`).

Sources: `runtime/scripts/backup-org.ts`, `runtime/scripts/restore-org.ts`.

## What a restore does

Restore is for a clean target that does not contain the organization. It
inserts rows in a fixed parent-before-child order and keeps the original UUIDs.
Most tables get a plain insert, so an existing row causes a primary-key error.
Five tables are handled differently:

| Table | Behavior |
| --- | --- |
| `billing_records` | Strip generated `token_delta` and `cost_delta_usd` so the database recomputes them. Strip the retired `cq_fee_usd` and `signed_hash` columns from pre-C2 backups; real and dry-run output names each stripped retired column and its row count. Keep IDs, token inputs, pinned price, event identity and provenance. |
| `tech_decisions` | Rows are inserted with supersession fields set to null. After all decisions exist, each reviewed link is written back with its original reviewer, evidence, and review time, and the update must match exactly one row. |
| `knowledge_entity_sessions`, `knowledge_edge_sessions` | Upsert that ignores duplicates, because database triggers recreate the first session link when the parent entity or edge is inserted. |
| `source_fact_links` | The target organization's links are deleted, then the backed-up rows are inserted with their original IDs and times. If the backup's list is empty, links that triggers created are deleted at the end. |

On any error, restore stops and reports how many rows it had inserted. It
does not roll back earlier tables. The target is then partial; reconcile it
before trying again (`docs/runbooks/LOCAL_STRATUM.md:104-105`). On success it
prints `Restored <N> row(s) across <K> tables for org <uuid>.`

Restore writes every `api_keys` row **inactive** by default (PB-64): a backup
cannot know about revocations made after it was taken, so a key revoked since
then must not come back to life. Restore prints a note with the number of keys
it restored inactive. Mint new keys for the organization's clients with
`npm run create-api-key`. Pass `--keep-key-state` only when you know that no
key was revoked after the backup; each key then keeps its backed-up
`is_active`. Restore targets a clean database: `api_keys` rows are plain
inserts, so a key that already exists in the target makes the insert fail and
restore stops, as described above.

Sources: `runtime/scripts/restore-org.ts`, `runtime/scripts/backup-org.ts`.

C4-A/M2 removes `invoices` and `invoice_send_claims` from the schema and new
exports. Legacy backups may contain either retired table; real and dry-run
restore report each present table and skipped row count, including zero.
Skipped rows do not contribute to insertion totals and their contents are not
printed. Old usage rows containing retired fee/signature columns are also
accepted and reported. Active-table, cross-organization, malformed-fact and
FK checks remain in force.

The focused synthetic legacy-usage check is
`npm run db:with-env -- node test/integration/local-legacy-usage-restore.mjs`
from `runtime/`. It uses its own organization and constructs synthetic legacy
invoice/claim arrays and pre-C2 usage columns. It checks table-skip and
column-strip reports in dry and real modes, then verifies retained usage
inputs, regenerated estimates, project identity and pruning references.
It does not use a real organization backup or recreate retired tables.

## The disposable recovery check

`npm run db:verify-recovery` runs
`runtime/test/integration/local-backup-recovery.mjs` through the local stack
wrapper. It uses a fresh random organization and never touches existing data.
In order, it:

1. Creates the organization with sessions, a project-scoped API key and
   conversation session, graph entities and an edge with extra session links,
   facts, an operational reference, audit results (one `CONFLICT`, one
   `UNVERIFIED`), and a reviewed decision supersession
   (`runtime/test/integration/local-backup-recovery.mjs`).
2. Writes a project-local dotenv override that points `SUPABASE_URL` at a
   closed port. The check fails if either CLI loads it, which shows that
   process credentials win (`runtime/test/integration/local-backup-recovery.mjs`).
3. Runs `backup-org.ts`, checks that retired invoice tables are absent, and
   checks exact row counts for 13 of the 21
   tables: `organizations`, `sessions`, `api_keys`, `function_changes`,
   `tech_decisions`, `operational_references`, `knowledge_entities`,
   `knowledge_edges`, `knowledge_entity_sessions`, `knowledge_edge_sessions`,
   `source_fact_links`, `audit_statuses`, and `audit_conflicts`. It also
   checks the exact IDs and times of the operational reference and source
   link. It does not count `developers`, `org_config`, `billing_records`,
   `policy_updates`, `todos`, `variable_changes`,
   `memory_vectors`, or `pruning_logs`
   (`runtime/test/integration/local-backup-recovery.mjs`).
4. Confirms restore exits 1 with the expected error for a backup missing
   `audit_statuses` and for a backup whose `audit_statuses` rows name another
   organization. After the first attempt it checks only that the source
   organization row still exists. After the second it does not query the
   database. The check itself does not prove that neither attempt wrote
   anything. In the code, both errors come from `validateBackup`, and restore
   returns on a validation error before it creates a database client
   (`runtime/test/integration/local-backup-recovery.mjs`,
   `runtime/scripts/restore-org.ts`).
5. Deletes the organization, confirms it is gone, runs `restore-org.ts`, and
   checks suppression, audit status, the unacknowledged alert, the decision
   supersession review fields, graph session links, the source link's ID and
   time, inactive restored API keys, and the session erasure inventory (`runtime/test/integration/local-backup-recovery.mjs`).
6. Deletes the organization again, restores a copy whose `source_fact_links`
   list is empty, and checks that no links remain
   (`runtime/test/integration/local-backup-recovery.mjs`).
7. Always attempts scoped row cleanup. Removes temporary files after success;
   preserves the synthetic files when the check or cleanup fails
   (`runtime/test/integration/local-backup-recovery.mjs`).

On success it prints
`local audited organization, graph provenance, and source-link backup and restore passed; retired tables omitted and fixture cleaned`
(`runtime/test/integration/local-backup-recovery.mjs`).

Source for the npm script: `runtime/package.json:64`.

## Known limits

- **Real data and clean machines are not verified.** The recovery check uses
  a fixture on the same running stack. Clean-machine and real-data recovery
  remain open under `plan.md` §7c "Backup + restore" (`plan.md:413`).
- **The current active-table manifest is required.** An older export missing
  a required active table fails validation and needs an explicit migration of
  the file. The two retired invoice tables are optional and skipped/reported;
  retired usage columns are stripped/reported and do not cause rejection
  (`runtime/scripts/restore-org.ts`).
- **No merge.** Restore cannot update an organization that already exists
  (`runtime/scripts/restore-org.ts`).
- **No partial rollback.** A failed restore leaves the rows it already
  inserted (`runtime/scripts/restore-org.ts`).
- **The recovery check only runs on the default stack.** It requires
  `SUPABASE_URL` to be exactly `http://127.0.0.1:54321`, so it refuses an
  isolated instance started with `DEVOPS_LOCAL_INSTANCE` and
  `DEVOPS_LOCAL_PORT` (`runtime/test/integration/local-backup-recovery.mjs`,
  `runtime/scripts/local-compose.ts:10-21`).
- **Gaps listed above.** The usage outbox, captured session files, and the
  model cache are outside the backup
  ([What a backup does not contain](#what-a-backup-does-not-contain)).
  C4-A/M2 retires historical invoice/claim data from the live schema. Legacy
  copies can still contain those rows; restore reports that it skips them.
  This is not proof that every backup, external copy or session was erased.
- **No scheduled backups.** No script in `runtime/scripts/` or `scripts/`
  runs a backup on a schedule. Backups happen when an operator runs one.

The current 21-table manifest is in `runtime/scripts/backup-org.ts` and is
reflected in `runtime/docs/MEMORY_AND_EVAL_COMMANDS.md`. Actual session erasure
and the one-year/<30-second benchmark remain unfinished under
`specs/memory/session-erasure.md`.
