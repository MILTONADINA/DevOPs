# Common operational tasks

Routine tasks for a local checkout: setup and teardown, tests and eval gates,
API keys, and migrations. Starting, checking, and stopping the database stack
in detail is in [LOCAL_STRATUM.md](LOCAL_STRATUM.md#start-and-check); this
page links there rather than repeating it.

Stratum commands run from `stratum/`. Commands that need the database go
through `npm run db:with-env -- ...` (`stratum/scripts/local-compose.ts:157-166`).

## Setup

From the repository root:

```sh
npm run setup
```

`npm run setup` runs `scripts/setup-local.mjs`, which:

1. Detects macOS, Linux, or WSL2. Native Windows is refused.
2. Requires Node 20.11 or later.
3. Requires `docker compose` and a running Docker engine.
4. Runs `npm ci` in `stratum/` only if `stratum/node_modules/.bin/tsx` is
   missing.
5. Runs `npm run db:start` in `stratum/`.
6. Runs the proxy and database smoke check (`tsx scripts/smoke-setup.ts`
   through `db:with-env`).

On success it prints
`Local database and proxy startup smoke passed.` It does not read or create
`.env` files, and it does not configure a model provider. Its own last line
states that this check does not satisfy the clean-machine, cross-platform, or
real-data recovery release gates. `npm run setup` also works from `stratum/`.

To run a second, isolated stack beside the default one, set both
`DEVOPS_LOCAL_INSTANCE` (lowercase, starts with a letter, up to 20
characters, not `local`) and `DEVOPS_LOCAL_PORT` (1024-65535, not `54321`) for
`npm run setup` and for every later `db:*` command. Setting only one is an
error.

Sources: `package.json:12`, `stratum/package.json:8`, `scripts/setup-local.mjs:11-43`,
`stratum/scripts/local-compose.ts:10-21`, `stratum/docs/MEMORY_AND_EVAL_COMMANDS.md:22-27`.

## Teardown

From `stratum/`:

```sh
npm run db:stop
```

This runs `docker compose down` for this project's stack only. It keeps the
database volume, so data survives the next `npm run db:start`. A restart
generates a new JWT secret; start any `db:with-env` process again.

No repository script deletes the database volume or resets the database
(`docs/runbooks/LOCAL_STRATUM.md:18-21`). Removing the volume with Docker
tools destroys all local organizations. Back up any organization you need
first ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).

Sources: `stratum/package.json:57`, `stratum/scripts/local-compose.ts:134-136`,
`stratum/scripts/local-compose.ts:169`.

## Run tests

| Scope | Command | Needs |
| --- | --- | --- |
| Root | `npm test` (repository root) | Node only |
| Stratum unit | `npm test` | Stratum dependencies |
| Stratum types | `npm run typecheck` | Stratum dependencies |
| Stratum lint | `npm run lint` | Stratum dependencies |
| Claim proofs | `npm run validate:claims -- <claim.yml> --no-rerun` (repository root) | `tsx` through `npx` |
| Local database checks | `npm run db:verify`, `npm run db:verify-recovery`, and the other `db:verify-*` scripts | A running local stack |

The `db:verify-*` scripts each run one file from `stratum/test/integration/`
through the stack wrapper. `db:verify` and `db:verify-recovery` create and
remove their own fixture rows (`docs/runbooks/LOCAL_STRATUM.md:12-13`,
`stratum/test/integration/local-backup-recovery.mjs:196-202`).
`db:verify-source-fact-backfill` and `verify:graph-browser` do not go through
the wrapper.

To hold a test run to its floor, save the full output to a file and run:

```sh
node scripts/check-test-floor.mjs root <log-file>
node scripts/check-test-floor.mjs stratum <log-file>
```

It exits 1 when the passed count is below `governance/test-floors.json`, when
any test failed, or when it cannot find a count. CI runs both checks and also
runs `stratum/test/integration/*.sql` against the database container after
`npm run setup`; no npm script wraps the SQL files.

Do not use `npm run test:all` as a quick check. It ends with `test:eval`,
which spends provider credits (next section).

Sources: `package.json:15-16`, `stratum/package.json:14-21`,
`stratum/package.json:60-83`, `scripts/check-test-floor.mjs:1-9`,
`.github/workflows/ci.yml:16-38`, `.github/workflows/ci.yml:54-60`,
`.github/workflows/ci.yml:83-86`, `DEVELOPER_GUIDE.md:42-53`.

## Run the eval gates

The eval gates decide whether pruning may ship. Pruning is not active in
requests today, so these gates do not affect running traffic. The full
command table, datasets, and environment variables are in
[MEMORY_AND_EVAL_COMMANDS.md](../../stratum/docs/MEMORY_AND_EVAL_COMMANDS.md#eval--pruning-gate-commands).

Free commands (local ONNX encoder, no model API calls):

| Command | Pass condition |
| --- | --- |
| `npm run eval:tierc` | Exit 0 only if all 50 critical golden queries pass. |
| `npm run eval:locomo:survival` | Report only. Prints `GATED: ... Exiting 0.` when `evals/datasets/locomo/locomo10.json` is absent. That exit 0 means nothing ran. |
| `npm run eval:longmemeval:survival` | Report only; same dataset caution. |

Commands that call a paid judge when `EVAL_ANTHROPIC_API_KEY` or
`ANTHROPIC_API_KEY` is set: `npm run test:eval`, `npm run test:eval -- --fast`,
`npm run eval:tierb`, `npm run eval:locomo`, and `npm run eval:longmemeval`.
Get the owner's approval before running any of them with a provider key. With
`EVAL_LOCAL_BASE_URL` and `EVAL_LOCAL_MODEL` set instead, these commands use a
loopback model; that result is labeled exploratory and cannot pass the release
gate. When they find no provider, they print `GATED` and exit 1.

`npm run eval:dev` works differently:

- It checks only `ANTHROPIC_API_KEY`. If that is unset, it prints
  `eval:dev GATED: ...` and exits 0, even when `EVAL_ANTHROPIC_API_KEY` is
  set. That exit 0 means nothing ran.
- If `ANTHROPIC_API_KEY` is set, it calls Claude for the answers and the
  judge. The calls use `EVAL_ANTHROPIC_API_KEY` when it is set, and
  `ANTHROPIC_API_KEY` otherwise.
- It ignores `EVAL_LOCAL_BASE_URL` and `EVAL_LOCAL_MODEL`. Setting them does
  not stop it from spending provider credits.

Get the owner's approval before running `eval:dev` in any shell where
`ANTHROPIC_API_KEY` is set.

`npm run test:eval` runs Tier-C first and stops if it fails. It then needs the
Tier-B dataset and a judge; a missing input exits 1, never 0. Only `--fast`
is accepted as a flag. Full mode also runs the LoCoMo and LongMemEval Tier-A
gates.

Sources: `stratum/package.json:20`, `stratum/package.json:27-33`,
`stratum/scripts/eval-tierc.ts:1-24`, `stratum/scripts/eval-locomo-survival.ts:1-21`,
`stratum/scripts/eval-locomo-survival.ts:66-69`, `stratum/scripts/eval-longmemeval-survival.ts:1-16`, `stratum/scripts/eval-longmemeval-survival.ts:59`,
`stratum/evals/harness/runner.ts:113-220`, `stratum/evals/harness/metrics.ts:172-183`,
`stratum/evals/harness/metrics.ts:74-88`, `stratum/evals/harness/metrics.ts:325`,
`stratum/evals/harness/metrics.ts:348`, `stratum/scripts/eval-dev.ts:18`,
`stratum/scripts/eval-dev.ts:43-46`, `stratum/scripts/eval-dev.ts:74`,
`stratum/scripts/eval-tierb.ts:27-30`, `stratum/scripts/eval-locomo.ts:169-183`,
`stratum/scripts/eval-longmemeval.ts:81-95`,
`stratum/docs/COMMERCIAL_ONBOARDING.md:100`, `stratum/docs/LOCAL_STORAGE.md:102`.

## Create an organization

```sh
npm run db:with-env -- npm run create-org -- --name "Org Name" --plan starter
```

`--plan` accepts `starter`, `growth`, `enterprise`, or `custom` and rejects
anything else. The plan sets the invoice floor. Require the
`Organization created:` line and record the printed `id`. `--with-key` also
mints an unbound key in the same step.

`create-org` loads `dotenv/config`, so it also reads a `stratum/.env` if one
exists. Values already in the process environment, such as the ones
`db:with-env` supplies, take precedence.

Sources: `stratum/package.json:53`, `stratum/scripts/create-org.ts:1-12`,
`stratum/scripts/create-org.ts:26-55`, `stratum/scripts/create-org.ts:75-96`.

## Mint an API key

```sh
npm run db:with-env -- npm run create-api-key -- \
  --org-id 'organization-uuid' --name 'label' --project-scope 'project-slug'
```

- The script generates a 256-bit key, stores only its SHA-256 hash, and prints
  the raw key once. It cannot be shown again. Copy it into the client's secret
  store and clear it from terminal scrollback where you can.
- Keys are `cq_live_…` by default; `--env test` makes a `cq_test_…` key.
- `--project-scope` binds the key to one project (lowercase slug, 1-64
  characters). Without it the key is unbound.
- Clients send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.
- Require the `API key created` line and record the printed `id`. You need
  the ID to revoke the key.

Sources: `stratum/package.json:54`, `stratum/scripts/create-api-key.ts:1-47`,
`stratum/scripts/create-api-key.ts:75-93`, `stratum/src/proxy/auth.ts:33-56`,
`stratum/src/proxy/auth.ts:59-61`.

## Revoke an API key

List the organization's keys. The list shows ID, name, project scope, creation
time, and status. It never shows the key or its hash.

```sh
npm run db:with-env -- npm run api-keys -- --org-id 'organization-uuid' --list
```

Revoke one key by ID:

```sh
npm run db:with-env -- npm run api-keys -- --org-id 'organization-uuid' --revoke 'key-uuid'
```

Revocation sets `is_active=false`. The row stays. The proxy rejects the key on
the next request, because it checks for an active key on every request. The
command only matches a key in the given organization. Require
`Revoked key <id> (is_active=false).`; `No matching ... key` exits 1.

After a restore from an older backup, repeat any revocation made since that
backup ([BACKUP_RESTORE.md](BACKUP_RESTORE.md#what-a-restore-does)).

Sources: `stratum/package.json:55`, `stratum/scripts/api-keys.ts:1-10`,
`stratum/scripts/api-keys.ts:58-82`, `stratum/src/proxy/auth.ts:73-83`.

### Missing database settings fail loudly

`create-org`, `create-api-key`, and `api-keys` exit 2 when `SUPABASE_URL` or
`SUPABASE_SERVICE_KEY` is missing, for example when run without `db:with-env`,
and say that nothing was created, listed or revoked. (Before PB-66 they printed
`SKIPPED` and exited 0.) Still check for the success line named above.

Sources: `stratum/scripts/create-org.ts:67-71`, `stratum/scripts/create-api-key.ts:59-63`,
`stratum/scripts/api-keys.ts:50-55`.

## Apply migrations

Migrations are the SQL files in `stratum/supabase/migrations/`. There are no
down migrations; a migration cannot be undone by a script.

How the runner works (`npm run db:migrate`, and also during `npm run db:start`):

- It takes files named `<digits>_<name>.sql`, sorted by file name.
- It skips any version already recorded in `devops_local.migrations`.
- It runs each new file and its version record in one transaction, with
  `ON_ERROR_STOP`. A failing file leaves no partial changes from that file,
  and the run stops. Files applied before it stay applied.
- After applying at least one file, it tells PostgREST to reload its schema.
- It prints `<N> migration(s) applied.`

To apply migrations safely:

1. Read each new migration file before applying it.
2. Back up every organization you need and verify each file
   ([LOCAL_STRATUM.md](LOCAL_STRATUM.md#back-up-one-organization),
   [BACKUP_RESTORE.md](BACKUP_RESTORE.md#verify-a-backup)).
3. With the stack running, from `stratum/`:

   ```sh
   npm run db:migrate
   ```

4. Require exit code 0 and the count line. Then run `npm run db:verify` and
   the `db:verify-*` checks for the areas the migration changed.

A migration that adds an organization table does not add it to backups. The
backup table list is fixed in code (`stratum/scripts/backup-org.ts:22-43`), so
the new table is left out until someone adds it to that list. That is how
`invoice_send_claims` is outside the backup today
([BACKUP_RESTORE.md](BACKUP_RESTORE.md#what-a-backup-does-not-contain)). Once
the list is changed, restore rejects backups taken before the change, because
it accepts only the current table list (`stratum/scripts/restore-org.ts:75-84`,
[BACKUP_RESTORE.md](BACKUP_RESTORE.md#known-limits)).

If a migration fails, read the error, fix the file or the data, and run
`npm run db:migrate` again. Do not insert version rows into
`devops_local.migrations` by hand to skip a file.

Sources: `stratum/package.json:56-58`, `stratum/scripts/local-compose.ts:111-125`,
`stratum/scripts/local-compose.ts:139-141`, `stratum/scripts/local-compose.ts:170`,
`stratum/scripts/restore-org.ts:75-84`, `docs/runbooks/LOCAL_STRATUM.md:18-21`.
