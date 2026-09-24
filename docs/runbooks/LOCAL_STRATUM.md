# Local Stratum operations

This runbook covers the project-local PostgreSQL, PostgREST, and gateway stack.
It is for development on this machine. The retired hosted Supabase project is
not part of this procedure. Run commands from `stratum/` unless stated otherwise.

## Start and check

1. Start Docker, then run `npm run db:start`. This starts the project Compose
   stack, applies pending migrations, and checks that the gateway binds only to
   `127.0.0.1:54321`. Database and PostgREST ports are not published.
2. Run `npm run db:verify` for a disposable service-role API round trip. It
   creates and removes its own organization and audit rows.
3. For the commercial proxy, use `npm run db:with-env -- npm run dev` after
   setting the required provider settings in the process environment. The
   wrapper supplies a fresh local database URL and service JWT to that process.

`npm run db:stop` stops this project's containers and keeps its data volume.
`npm run db:migrate` applies pending migrations to a running stack. Before
applying migrations to data you need, make an organization backup and verify
that its file exists. There is no supported automatic database reset command.

## Back up one organization

1. Identify the organization's UUID from your own authorized records. Choose
   an output path under this project's ignored `stratum/backups/` directory.
2. Restrict newly created files, then export:

   ```sh
   umask 077
   npm run db:with-env -- npm run backup -- --org-id 'replace-with-org-uuid' --out backups/org.backup.json
   ```

3. Require exit code 0 **and** the final row-count/path line. Confirm that
   `backups/org.backup.json` exists and is nonempty. A missing organization,
   failed table read, or missing database credential is a failure. Treat this
   JSON as sensitive organization data; keep it inside the project boundary
   and do not paste its contents into an issue or log.

The export includes the current table manifest, organization rows, session
logs, graph provenance, source links, audit state, and billing rows. It pages
large tables. It is a logical snapshot for one organization, not a full
PostgreSQL volume backup or an atomic cross-table point-in-time snapshot.

## Restore into a clean target

1. Confirm the target stack is running and has the schema version that
   supports the backup's table manifest. The restore CLI accepts only the
   current manifest; older snapshots need an explicit migration. Keep the
   backup file in `stratum/backups/`.
2. Validate the file and inspect its table counts without writing:

   ```sh
   npm run restore -- --file backups/org.backup.json --dry-run
   ```

3. Confirm the target does not already contain that organization. Restore
   performs plain inserts and fails on primary-key collisions; it does not
   merge an existing organization. On the clean target, run:

   ```sh
   npm run db:with-env -- npm run restore -- --file backups/org.backup.json
   ```

4. Require exit code 0 and the `Restored ... row(s)` line. Check the expected
   organization, sessions, facts, suppression and audit status through the
   scoped API before resuming dependent work. A dry run verifies file shape
   and counts only; it does not prove that foreign keys or all inserts will
   succeed. If a live restore fails after some inserts, treat the target as
   partial and reconcile it before retrying. Do not rerun blindly.

For a disposable local drill, run `npm run db:verify-recovery`. That command
creates, backs up, deletes, restores, checks, and removes a fixture
organization. It does not verify recovery of real data or a clean machine.

## Incident triage

| Symptom | First check | Next action |
| --- | --- | --- |
| `db:start` says Docker or Compose is unavailable | Docker engine and `docker compose version` | Start Docker or install Compose, then rerun `db:start`. |
| Gateway binding rejected | Check whether another process owns port 54321 and inspect `docker compose -f supabase/docker-compose.local.yml -p devops-stratum-compose ps` | Free the port or correct the local binding; rerun `db:start` only after the cause is fixed. |
| API or proxy cannot reach the database | `npm run db:verify`; check that `db:start` completed | Restart only this project's stack with `db:stop` then `db:start`; use a new `db:with-env` process because a restart rotates the local JWT secret. |
| Backup or restore reports missing credentials | Check that the command used `db:with-env` and the stack is running | Rerun the failed command through the wrapper; do not infer success from a dry run. |
| Restore rejects a table or row | Read the exact manifest or organization mismatch error | Preserve the backup; migrate the snapshot deliberately or correct the source. Do not edit evidence rows to force acceptance. |
| Restore fails after writing rows | Inspect the scoped target rows and error | Reconcile or rebuild a clean target before another restore. |

For design and security boundaries, see [local storage](../../stratum/docs/LOCAL_STORAGE.md).
