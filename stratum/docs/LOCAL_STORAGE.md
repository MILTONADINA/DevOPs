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
