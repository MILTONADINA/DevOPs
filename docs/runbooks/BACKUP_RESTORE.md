# Backup and restore

This runbook explains what the organization backup and restore scripts cover,
how to check a backup file, what the disposable recovery check proves, and
where the limits are. The step-by-step commands for a backup and a restore are
in [LOCAL_STRATUM.md](LOCAL_STRATUM.md#back-up-one-organization) and
[LOCAL_STRATUM.md](LOCAL_STRATUM.md#restore-into-a-clean-target). Follow those
steps; this page does not repeat them.

Both scripts target the project-local Compose stack. The hosted Supabase
project is retired
(`stratum/docs/decisions/0020-local-storage-after-hosted-retirement.md`).

## The two scripts

| Script | npm script (from `stratum/`) | Writes to the database |
| --- | --- | --- |
| `stratum/scripts/backup-org.ts` | `npm run backup -- --org-id <uuid> [--out <path>] [--pretty]` | No. It only reads. |
| `stratum/scripts/restore-org.ts` | `npm run restore -- --file <path> [--dry-run]` | Yes, unless `--dry-run` is given. |

Both read `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the process
environment, so run them through `npm run db:with-env -- ...`. A dry-run
restore needs neither, because it returns before reading them.

Sources: `stratum/package.json:47-48`, `stratum/scripts/backup-org.ts:8`,
`stratum/scripts/backup-org.ts:168-173`, `stratum/scripts/restore-org.ts:9`,
`stratum/scripts/restore-org.ts:241-251`.

## What a backup contains

A backup is one JSON object with three keys: `orgId`, `exportedAt`, and
`tables`. `tables` maps each table name to an array of rows. The file holds
22 tables:

- `organizations`, selected by `id`.
- These 20 tables, selected by `org_id`: `developers`, `org_config`,
  `sessions`, `billing_records`, `invoices`, `function_changes`,
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
`stratum/`, where `backups/` is ignored by Git. The script writes the file
with default permissions, which is why the LOCAL_STRATUM procedure sets
`umask 077` first.

The file holds organization data, including `api_keys` rows with their key
hashes and `billing_records`. Treat it as sensitive.

Sources: `stratum/scripts/backup-org.ts:22-49`,
`stratum/scripts/backup-org.ts:95-113`, `stratum/scripts/backup-org.ts:124-156`,
`stratum/scripts/backup-org.ts:176-185`, `stratum/.gitignore:71-72`,
`stratum/src/proxy/auth.ts:33-42`, `docs/runbooks/LOCAL_STRATUM.md:62-67`.

## What a backup does not contain

- **`invoice_send_claims`.** Migration
  `20260924235900_invoice_send_claims.sql` creates this table, but it is not
  in the export list, and restore rejects any table it does not know. The
  schema creates 23 tables; the backup covers 22. This table is the guard
  against billing a period twice. `npm run invoice -- --send` inserts a claim
  row for the organization and period before it calls Stripe, and the row
  stays after an ambiguous Stripe error until an operator reconciles. A
  restore brings back no claims. After a restore, `--send` is blocked only by
  an `invoices` row for that period whose status is not `failed`. A claimed
  period with no such row, for example after an ambiguous error, can be billed
  again. `--inspect-claim` and `--reconcile` refuse to run without a claim row,
  so they cannot help on the restored organization. Before you run
  `npm run invoice -- --send` against a restored organization, check Stripe
  directly for invoices in each period that had a claim before the restore.
- **Files on disk.** The proxy keeps billing usage events in a local outbox
  directory (default `stratum/data/usage-outbox/`) and reads captured sessions
  from `stratum/data/sessions/`. The encoder model cache is
  `stratum/models/`. None of these are in the backup. Events still in the
  outbox are not yet in `billing_records`, so they are not in the backup
  either.
- **The database volume, other organizations, and schema state.** This is a
  logical export of one organization, not a PostgreSQL volume backup. It does
  not record which migrations were applied (`devops_local.migrations`).
- **A consistent point in time.** Tables are read one after another, so the
  file is not an atomic cross-table snapshot.

Sources: `stratum/supabase/migrations/20260924235900_invoice_send_claims.sql:1-4`,
`stratum/src/billing/invoice-ledger.ts:71-94`, `stratum/src/billing/invoice-ledger.ts:124-127`,
`stratum/src/billing/invoice-ledger.ts:146`, `stratum/src/billing/invoice-ledger.ts:166-168`,
`stratum/scripts/invoice.ts:180-188`,
`stratum/scripts/restore-org.ts:75-84`, `stratum/src/proxy/index.ts:198-199`,
`stratum/src/proxy/index.ts:226`, `stratum/.gitignore:43-49`,
`stratum/scripts/local-compose.ts:113`, `docs/runbooks/LOCAL_STRATUM.md:75-78`.

## Verify a backup

1. Require exit code 0 and the final summary line from the backup command:
   `<N> row(s) across <M> tables → <path>`. `M` is 22 for a current export.
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
- a missing expected table, or any table restore does not support;
- a file without `operational_references` (an export from before that table
  existed);
- any row in an organization-scoped table, or in `source_fact_links`, whose
  `org_id` differs from `orgId`;
- decision supersession links that are missing, duplicated, cross-project,
  not newer than the decision they replace, or lack a reviewer, at least 20
  characters of evidence, and a review time;
- conversation sessions whose API key is not in the file, and `pruning_logs`
  rows whose session is not in the file.

It does not prove that foreign keys or all inserts will succeed on a target
(`docs/runbooks/LOCAL_STRATUM.md:102-104`).

Sources: `stratum/scripts/backup-org.ts:193`, `stratum/scripts/restore-org.ts:67-159`,
`stratum/scripts/restore-org.ts:234-244`.

## What a restore does

Restore is for a clean target that does not contain the organization. It
inserts rows in a fixed parent-before-child order and keeps the original UUIDs.
Most tables get a plain insert, so an existing row causes a primary-key error.
Five tables are handled differently:

| Table | Behavior |
| --- | --- |
| `billing_records` | The generated columns `token_delta`, `cost_delta_usd`, and `cq_fee_usd` are removed before insert. The database recomputes them. |
| `tech_decisions` | Rows are inserted with supersession fields set to null. After all decisions exist, each reviewed link is written back with its original reviewer, evidence, and review time, and the update must match exactly one row. |
| `knowledge_entity_sessions`, `knowledge_edge_sessions` | Upsert that ignores duplicates, because database triggers recreate the first session link when the parent entity or edge is inserted. |
| `source_fact_links` | The target organization's links are deleted, then the backed-up rows are inserted with their original IDs and times. If the backup's list is empty, links that triggers created are deleted at the end. |

On any error, restore stops and reports how many rows it had inserted. It
does not roll back earlier tables. The target is then partial; reconcile it
before trying again (`docs/runbooks/LOCAL_STRATUM.md:104-105`). On success it
prints `Restored <N> row(s) across <K> tables for org <uuid>.`

Restore writes `api_keys` rows exactly as they were backed up, including
`is_active`. A key revoked after the backup was taken is active again after
the restore. Re-run each revocation made since the backup
([COMMON_TASKS.md](COMMON_TASKS.md#revoke-an-api-key)) before the organization
is used.

Sources: `stratum/scripts/restore-org.ts:21-49`, `stratum/scripts/restore-org.ts:173-192`,
`stratum/scripts/restore-org.ts:254-286`, `stratum/scripts/backup-org.ts:42`.

## The disposable recovery check

`npm run db:verify-recovery` runs
`stratum/test/integration/local-backup-recovery.mjs` through the local stack
wrapper. It uses a fresh random organization and never touches existing data.
In order, it:

1. Creates the organization with sessions, a project-scoped API key and
   conversation session, graph entities and an edge with extra session links,
   facts, an operational reference, audit results (one `CONFLICT`, one
   `UNVERIFIED`), and a reviewed decision supersession
   (`stratum/test/integration/local-backup-recovery.mjs:67-116`).
2. Writes a project-local dotenv override that points `SUPABASE_URL` at a
   closed port. The check fails if either CLI loads it, which shows that
   process credentials win (`stratum/test/integration/local-backup-recovery.mjs:118-121`,
   `stratum/test/integration/local-backup-recovery.mjs:44-51`).
3. Runs `backup-org.ts` and checks exact row counts for 13 of the 22
   tables: `organizations`, `sessions`, `api_keys`, `function_changes`,
   `tech_decisions`, `operational_references`, `knowledge_entities`,
   `knowledge_edges`, `knowledge_entity_sessions`, `knowledge_edge_sessions`,
   `source_fact_links`, `audit_statuses`, and `audit_conflicts`. It also
   checks the exact IDs and times of the operational reference and source
   link. It does not count `developers`, `org_config`, `billing_records`,
   `invoices`, `policy_updates`, `todos`, `variable_changes`,
   `memory_vectors`, or `pruning_logs`
   (`stratum/test/integration/local-backup-recovery.mjs:122-137`).
4. Confirms restore exits 1 with the expected error for a backup missing
   `audit_statuses` and for a backup whose `audit_statuses` rows name another
   organization. After the first attempt it checks only that the source
   organization row still exists. After the second it does not query the
   database. The check itself does not prove that neither attempt wrote
   anything. In the code, both errors come from `validateBackup`, and restore
   returns on a validation error before it creates a database client
   (`stratum/test/integration/local-backup-recovery.mjs:139-157`,
   `stratum/scripts/restore-org.ts:80`, `stratum/scripts/restore-org.ts:91`,
   `stratum/scripts/restore-org.ts:226-232`, `stratum/scripts/restore-org.ts:252`).
5. Deletes the organization, confirms it is gone, runs `restore-org.ts`, and
   checks suppression, audit status, the unacknowledged alert, the decision
   supersession review fields, graph session links, the source link's ID and
   time, and the session erasure inventory (`stratum/test/integration/local-backup-recovery.mjs:159-189`).
6. Deletes the organization again, restores a copy whose `source_fact_links`
   list is empty, and checks that no links remain
   (`stratum/test/integration/local-backup-recovery.mjs:190-194`).
7. Always deletes its rows and temporary files, even on failure
   (`stratum/test/integration/local-backup-recovery.mjs:196-202`).

On success it prints
`local audited organization, graph provenance, and source-link backup and restore passed`
(`stratum/test/integration/local-backup-recovery.mjs:195`).

Source for the npm script: `stratum/package.json:64`.

## Known limits

- **Real data and clean machines are not verified.** The recovery check uses
  a fixture on the same running stack. Clean-machine and real-data recovery
  remain open under `plan.md` §7c "Backup + restore" (`plan.md:413`).
- **Only the current table manifest restores.** An older export fails
  validation and needs an explicit migration of the file
  (`stratum/scripts/restore-org.ts:75-84`).
- **No merge.** Restore cannot update an organization that already exists
  (`stratum/scripts/restore-org.ts:4-7`, `stratum/scripts/restore-org.ts:267`).
- **No partial rollback.** A failed restore leaves the rows it already
  inserted (`stratum/scripts/restore-org.ts:254-268`).
- **The recovery check only runs on the default stack.** It requires
  `SUPABASE_URL` to be exactly `http://127.0.0.1:54321`, so it refuses an
  isolated instance started with `DEVOPS_LOCAL_INSTANCE` and
  `DEVOPS_LOCAL_PORT` (`stratum/test/integration/local-backup-recovery.mjs:11-13`,
  `stratum/scripts/local-compose.ts:10-21`).
- **Gaps listed above.** `invoice_send_claims`, the usage outbox, captured
  session files, and the model cache are outside the backup. Losing the
  invoice claims removes the double-billing guard for claimed periods, so
  check Stripe before sending invoices for a restored organization
  ([What a backup does not contain](#what-a-backup-does-not-contain)).
- **No scheduled backups.** No script in `stratum/scripts/` or `scripts/`
  runs a backup on a schedule. Backups happen when an operator runs one.

`stratum/docs/MEMORY_AND_EVAL_COMMANDS.md:29-30` says the export covers 21
tables. The code exports 22 (`stratum/scripts/backup-org.ts:22-43`,
`stratum/scripts/backup-org.ts:127`, `stratum/scripts/backup-org.ts:143-153`).
