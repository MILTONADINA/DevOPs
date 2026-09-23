# Local Stratum storage

The owner retired the paused hosted Supabase project. Development uses a
project-local Docker Compose stack with Supabase PostgreSQL, PostgREST, and a
small `/rest/v1` gateway. No hosted project link is needed. This stack is for
development, not production.

## Start and stop

From `stratum/`, with Docker Desktop running:

```sh
npm run db:start
npm run db:stop
```

`db:start` starts only this project's containers and applies pending SQL
migrations in filename order. The gateway publishes `127.0.0.1:54321`; the
database and PostgREST publish no host ports. PostgreSQL is on an internal data
network; only the gateway has a host-facing network. Startup inspects the actual
Docker bindings and shuts down on any broad binding. A restart preserves the
Compose volume and skips migrations already recorded in
`devops_local.migrations`. `db:stop` preserves the volume too.

The database uses trust authentication only within this project's Docker
network. This is acceptable for a local development stack whose database has
no published port. Do not use this Compose file as a production deployment.
To apply newly added migrations to a running stack, run `npm run db:migrate`.
There is no automatic `db:reset` command because it would destroy local data.
Run `npm run db:verify` for a service-role HTTP audit round-trip; it creates
temporary organization, session, fact, status, and alert rows, then deletes
them. The SQL-only audit check is in `test/integration/local-compose-audit.sql`
and runs inside a rolled-back transaction.

Run `npm run db:verify-recall` for a disposable local SessionStart bridge check.
It seeds active, suppressed, and foreign organization facts, checks that only
the active bound fact appears, then removes the fixture. Run
`npm run db:with-env -- npm run verify-tier2` for the Tier-2 adapter's five-fact
round-trip and cleanup check; this command reads credentials only from its
process environment.

Run `npm run db:verify-promotion` to check local Tier-2 to Tier-3 promotion.
It uses the cached encoder without model downloads, verifies that an active
FunctionChange reaches the graph and vector store while a suppressed one does
not, runs the bound entity-status command, and removes its fixture. For a
manually selected organization, run
`npm run db:with-env -- npm run promote` with `PROMOTE_ORG_ID` set in the
process environment. No nightly scheduler is configured by this check.

On macOS, run `npm run promote:schedule -- install` from `stratum/` to register
the user-level 02:00 local launchd job. It runs the same promotion command
through `db:with-env` for a fresh local service JWT on each invocation. The
plist and output/error logs live in this project's `.workflow/state/` directory.
Use `npm run promote:schedule -- status` to inspect the registered job or
`npm run promote:schedule -- remove` to unregister it. The job runs when this
machine is awake and the local Compose stack is running; a sleeping machine or
stopped stack cannot complete that night's promotion.

Run `npm run db:verify-audit-git` for a disposable real-Git audit check. It
creates a small Git history inside this project, stores a fact anchored to its
rename commit, runs `audit:repo --persist`, verifies suppression plus the
CONFLICT status and alert through the local API, then removes its fixtures.
This checks the operator path; it does not run audit from proxy traffic.

Run `npm run db:verify-message-audit` for the opt-in proxy request path. The
check creates disposable local Git commits and a loopback extraction model,
then verifies a stale extracted fact is suppressed with a persisted CONFLICT
status and alert. An unrelated Todo becomes visible only after its UNVERIFIED
status is stored. The check also forces an audit RPC failure and confirms that
the unreviewed fact stays suppressed. For local use, set `CQ_AUDIT_REPO_ROOT`
to a real Git directory within this project and start the proxy through
`db:with-env`; the runner supplies `DEVOPS_STRATUM_PROJECT_ROOT` for the path
boundary. This audit indexes the latest 100 commits. Its status is
deterministic Tier 1 evidence; live dashboard timing and later escalation are
separate gates.

Run `npm run db:verify-proxy-memory` to check the commercial proxy's actual
startup wiring against the local API. It creates two organizations and hashed
API keys, then verifies authenticated fact, conflict, and status reads stay in
the key's organization even with a foreign `org-id` query. It also checks
missing/inactive keys and cross-organization suppression before cleanup.

Run `npm run db:verify-message-memory` to check a successful authenticated
`/v1/messages` request through a loopback fake extraction model. It verifies
one automatically created memory session and one validated fact under the
authenticated organization, then removes both. To enable this path for local
use, set `CQ_MEMORY_EXTRACT_MODEL=local/<model>` and `CQ_LOCAL_BASE_URL` to a
loopback HTTP OpenAI-compatible endpoint before starting the commercial proxy.
Without those settings, no memory extraction runs. The database session is
created per successful request; raw turns are not stored in PostgreSQL.

Run `npm run db:verify-request-survival` to check that a fact extracted from
the first authenticated message remains in the local database after 50 later
message requests and is returned by the project-bound SessionStart bridge.
The check uses a loopback fake extraction model and cleans up its organization,
key, sessions, and fact. It verifies the request and recall wiring, not a live
Claude hook or real-model extraction quality.

With a local OpenAI-compatible model already serving on loopback, set
`CQ_LOCAL_BASE_URL` to its `/v1` endpoint and `CQ_MEMORY_EXTRACT_MODEL` to its
`local/<model>` ID, then run `npm run db:verify-real-model-memory`. This sends
one authenticated request through the real local provider, uses that model to
extract a TechDecision, checks the local database and SessionStart recall, and
removes its fixture. It tests one explicit decision on that model; it does not
establish broad extraction quality or live Claude hook activation.

Run `npm run db:verify-recovery` for a disposable organization backup and
restore check. It exports a session, suppressed fact, audit status, and conflict
to a temporary file under the ignored `backups/` directory, deletes the rows,
restores them through the CLI, checks their IDs and audit evidence, and removes
the fixture. For operator use, run `backup` and `restore` through `db:with-env`;
restore expects a clean target. Both CLIs use process credentials and do not
load `.env`.

To run the proxy with this local database, start it through
`npm run db:with-env -- npm run dev` with `CQ_COMMERCIAL=true` and a supported
model provider configured in the process environment. The proxy entry point
also uses process settings directly and does not load `.env`.

For a command that needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, use
`npm run db:with-env -- <command> [args...]` from `stratum/`. It passes a
short-lived local service JWT through the child process environment without
printing or writing credentials. The URL is `http://127.0.0.1:54321` after
startup passes. A restart rotates the local JWT secret, so run
`db:with-env` again for each new command. The September 2026 audit migrations
are included.

The older Supabase CLI `config.toml` remains for migration compatibility; the
CLI's `start` command is not the supported local startup on this Docker
Desktop instance because its network-level loopback setting was ignored.
This minimal Compose stack provides PostgreSQL and the REST API used by current
Stratum adapters; it does not run Supabase Studio, Auth, Storage, or Realtime.

Local migration and API checks do not satisfy the deployed v0.5/v0.6 latency
gates or the v1 commercial storage gate. Those need a separately operated
production service and verification.
