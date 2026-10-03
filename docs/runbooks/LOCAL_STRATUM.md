# Local Stratum operations

This runbook covers the project-local PostgreSQL, PostgREST, and gateway stack.
It is for development on this machine. The retired hosted Supabase project is
not part of this procedure. Run commands from `runtime/` unless stated otherwise.

## Start and check

1. Start Docker, then run `npm run db:start`. This starts the project Compose
   stack, applies pending migrations, and checks that the gateway binds only to
   `127.0.0.1:54321`. Database and PostgREST ports are not published.
2. Run `npm run db:verify` for a disposable service-role API round trip. It
   creates and removes its own organization and audit rows.
3. For the commercial proxy, use `CQ_COMMERCIAL=true npm run db:with-env -- npm run dev` after
   setting the required provider settings in the process environment. The
   wrapper supplies a fresh local database URL and service JWT to that process.

`npm run db:stop` stops this project's containers and keeps its data volume.
`npm run db:migrate` applies pending migrations to a running stack. Before
applying migrations to data you need, make an organization backup and verify
that its file exists. There is no supported automatic database reset command.
These ordinary commands apply to an unactivated stack. The generic credential
wrapper refuses an enabled erasure deployment and every reserved `erasure-*`
instance, including a reserved instance that is still disabled.

## Limited managed erasure candidate

**C4-B status:** the generation migration and focused SQL checks have passed on
the isolated verification stack. On 2026-10-03, the actual authenticated HTTP
proof passed for the initial `managed_explicit_session_v1` class using normal
constructors/writers and the shipped proxy entry. It verified private-data
deletion, shared/foreign-data survival, unknown-coverage refusal, rollback and
a stable receipt after a lost response. The matching activation was then
disabled and its consumers stopped. The local evidence is
`.workflow/proofs/c4b-2026-10-03/erasure-api-a1f74062-1674-44f2-90f1-4425f7d57180.json`,
bound to manifest digest
`9bdacccab02dcc3257703b82341dc011d9a3c7f682798fbf33bba56c89976e35`.
This small fixture does not establish the one-year performance gate or wider
session/copy coverage.

The original operator stack remains disabled/ineligible. The first positive
proof requires a **new** reserved `erasure-*` instance, fresh volume, distinct
generated credentials and a separate loopback port. It must never have issued
unrestricted credentials while disabled: such a token would survive activation.
Do not reuse the earlier SQL verification stack or interpret a restart/empty
table set as proof of a fresh database.

Trusted operator preparation records the new volume/container/image identities,
exact applied migration bytes, clean locked dependency installation and actual
bootstrap/toolchain source. It freezes source, dependencies, configuration,
allowed selectors and store paths in
`.workflow/erasure-artifacts/<name>/erasure-manifest.json`. The manifest and all
code/dependency directories are readonly, the artifact root is private, and
only its private `runtime/data` directories are writable. Symlink escapes,
unlisted dotenv files, mutable inputs and ambient loader overrides are refused;
the bound tsx loader runs with its shared cache disabled.

Privileged activation binds the manifest's computed digest in
`erasure_deployment.source_manifest_sha256` with a fresh activation UUID. The
protocol label `managed_explicit_session_v1` alone is not source evidence.
Applying migrations, setting an environment flag or passing service-role fields
does not activate it. The launcher verifies the artifact and database binding,
loopback ports and fresh store directories before issuing its child credential;
volume history and image/migration identity are separately recorded operator
evidence, not facts the launcher reconstructs.

After that reviewed preparation, the restricted operator command is:

```sh
DEVOPS_LOCAL_INSTANCE=erasure-proof DEVOPS_LOCAL_PORT=54329 \
  node node_modules/tsx/dist/cli.mjs scripts/local-compose.ts \
  erasure-launch /absolute/project/.workflow/erasure-artifacts/name/erasure-manifest.json api-proof
```

The instance, port and artifact locator above are placeholders that must match
the reviewed binding. Only `api-proof` and `proxy` are public selectors. The
proof driver invokes the real organization/key CLIs with their required
arguments and starts the actual proxy entry through fixed Node/artifact-local
tsx paths. Those creator scripts remain bound inputs, not standalone selectors.
The launch marker is single-use and is not reset after a failed child. General
managed onboarding, restart, artifact replacement and adoption of old stores
are unproved; this first-run procedure is not their implementation.

Only newly minted organizations and normal capped explicit sessions can obtain
the initial coverage. Existing/imported/restored organizations, conversation
sessions and unknown consumers remain ineligible. Protected reads/exports mark
organization-wide uncertainty before copying; successful copying never restores
eligibility. Backup/recall/audit commands are not extra restricted-launch selectors.

An organization-level key can request read-only
`GET /v1/sessions/:id/erasure-preflight`; execution uses
`POST /v1/sessions/:id/erasure` without caller scope or coverage options. Personal
and project-bound requests are forbidden; foreign/missing sessions are not
disclosed. Blocked execution returns 409, unavailable/incomplete execution 503;
successful completion carries a stable receipt. DELETE continues to end the
session only. Unknown managed stores include `stores_not_inventoried`, and
unsigned usage rows never create a financial-retention blocker.

The reported boundary excludes client-held responses, privileged host/database
snapshots and physical heap/OS remnants; exclusion does not mean erasure or
anonymization. Broader historical/conversation/copied-data support and the
one-year/<30-second benchmark remain open. See
[session-erasure requirements](../../specs/memory/session-erasure.md).

## Review a decision replacement

When a newer TechDecision genuinely replaces an older one, collect both exact
decision UUIDs and preview the pair with the local operator command:

```sh
npm run db:with-env -- npm run review:decision -- \
  --org-id 'organization-uuid' --project-scope 'project-slug' \
  --older-id 'old-decision-uuid' --newer-id 'new-decision-uuid'
```

Use `--unbound` in place of `--project-scope` for an explicitly unbound pair.
Preview leaves decision content and reviewed links unchanged. Before reading
the pair, it durably marks the organization's erasure coverage unknown because
the displayed content becomes an untracked application copy. If that marker
fails, the command exits nonzero before reading or displaying the pair; it does
not fall back to an unguarded read. Both decisions must be active in the same
organization and project, and the newer one must have a later creation time. A shared domain or similar wording is insufficient
evidence. After independently checking the replacement, supply a reviewer and
at least 20 characters of concrete evidence on standard input, then add
`--apply` to that command. The CLI does not echo the evidence or service JWT.
For example, enter the evidence at a shell prompt and pipe it without putting
its text in the command history:

```sh
IFS= read -r review_evidence
printf '%s\n' "$review_evidence" | npm run db:with-env -- npm run review:decision -- \
  --org-id 'organization-uuid' --project-scope 'project-slug' \
  --older-id 'old-decision-uuid' --newer-id 'new-decision-uuid' \
  --reviewer 'operator-name' --apply
unset review_evidence
```

It calls `review_tech_decision_supersession` once and verifies the recorded
link. The link and review metadata cannot be edited after creation. Backups
retain the original review record. Never put the local service JWT in a
project file.

## Back up one organization

1. Identify the organization's UUID from your own authorized records. Choose
   an output path under this project's ignored `runtime/backups/` directory.
2. Restrict newly created files, then export:

   ```sh
   umask 077
   npm run db:with-env -- npm run backup -- --org-id 'replace-with-org-uuid' --out backups/org.backup.json
   ```

   Before its first content read, export durably marks the organization's erasure
   coverage unknown. This metadata write is required: the backup is a new copy.
   A failed marker stops the export before reads/file output, and a completed
   export does not clear the uncertainty.

3. Require exit code 0 **and** the final row-count/path line. Confirm that
   `backups/org.backup.json` exists and is nonempty. A missing organization,
   failed table read, or missing database credential is a failure. Treat this
   JSON as sensitive organization data; keep it inside the project boundary
   and do not paste its contents into an issue or log.

The export covers the 21 application tables in its manifest: organization rows,
session/pruning data, graph provenance, source links, audit state and unsigned
usage in `billing_records`. It omits retired `invoices`/`invoice_send_claims`
and private erasure deployment/coverage/receipt/tombstone metadata. It pages
large tables. It is a logical application snapshot for one organization, not a full
PostgreSQL volume backup or an atomic cross-table point-in-time snapshot.

## Restore into a clean target

1. Confirm the target stack is running with the current schema and restore
   admission RPC. The file must contain all 21 application-table arrays. Older
   backups may additionally contain either retired invoice table; restore
   validates and skips each, reporting its row count even when zero. Missing
   active tables or unsupported additional tables still fail validation. Keep
   the backup file in `runtime/backups/`.
2. Validate the file and inspect its table counts without writing:

   ```sh
   npm run restore -- --file backups/org.backup.json --dry-run
   ```

3. Confirm the target does not already contain that organization UUID. Before
   any active-table insertion, restore admission checks all represented session,
   fact and entity identities/references against known global session authority
   and completed erasure tombstones, then durably marks imported coverage
   unknown. A denied/unacknowledged admission inserts no active rows. Restore
   preserves backup UUIDs and never merges or reenrolls an organization. Run:

   ```sh
   npm run db:with-env -- npm run restore -- --file backups/org.backup.json
   ```

   Generated usage columns are recomputed. Retired `cq_fee_usd`/`signed_hash`
   columns are stripped and reported. API keys return inactive unless explicitly
   using `--keep-key-state`; graph provenance, source-link IDs/timestamps and
   reviewed-decision evidence are preserved.

4. Require exit code 0 and the `Restored ... row(s)` line. Check the expected
   organization, sessions, facts, suppression and audit status through the
   scoped API before resuming dependent work. A dry run verifies file shape
   and counts only; it does not prove that foreign keys or all inserts will
   succeed. If a live restore fails after some inserts, treat the target as
   partial and reconcile it before retrying. Do not rerun blindly.

Admission and subsequent HTTP inserts are separate transactions; row guards
still reject intervening erasure conflicts. The application backup does not
carry global erasure history. Missing historical authority is not proof that
an identity was never erased, and imported data stays ineligible. Do not clear
fences/tombstones or uncertainty to force a restore through.

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
| Reserved/enabled erasure stack rejects `db:with-env` | Confirm the intended instance and reviewed manifest | Use only the prepared restricted launch; do not extract credentials or remove the single-use marker to bypass it. |
| Generation admission refuses startup | Inspect the source/manifest/activation/store mismatch before changing anything | Preserve the failed-run evidence; providers and outbox must not start under a mismatched binding. General restart/rebind is not supported by the initial launcher. |
| Restore admission rejects an identity | Check the target UUID and known session/tombstone conflict | Preserve the backup and protected history; do not delete authority records to manufacture a clean target. |
| Restore rejects a table or row | Read the exact manifest or organization mismatch error | Preserve the backup; migrate the snapshot deliberately or correct the source. Do not edit evidence rows to force acceptance. |
| Restore fails after writing rows | Inspect the scoped target rows and error | Reconcile or rebuild a clean target before another restore. |

For design and security boundaries, see [local storage](../../runtime/docs/LOCAL_STORAGE.md).
