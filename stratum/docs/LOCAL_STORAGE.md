# Local Stratum storage

The owner retired the paused hosted Supabase project. Development uses the
Supabase CLI's local PostgreSQL and HTTP API; no hosted project link is needed.
This local stack is not a production deployment.

## Start and stop

From `stratum/`, with Docker Desktop running:

```sh
npm run db:start
npm run db:stop
```

`db:start` creates a project-specific Docker network, starts Postgres and the
API, and checks the *actual* published API and database addresses. If either
port is available outside loopback, it stops this project's stack and exits
nonzero. On this Mac, Docker Desktop currently publishes both ports on all
interfaces despite the network's loopback option. Docker's
[`Port binding behavior`](https://docs.docker.com/enterprise/security/hardened-desktop/settings-management/settings-reference/#port-binding-behavior)
setting must permit local-only binding before this startup command can pass.
Changing that Docker Desktop setting can affect other containers.

The local CLI applies all committed migrations on a fresh database. The
September 2026 audit status and conflict migrations are included. `db:reset`
deletes local data and should only be used on a disposable development stack.

`supabase status` prints local credentials. Use them only in your own terminal
for the process that needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`; do not
commit or paste them into chat. The local API URL is
`http://127.0.0.1:54321` when startup passes.

Local migration and API checks do not satisfy the deployed v0.5/v0.6 latency
gates or the v1 commercial storage gate. Those need a separately operated
production service and verification.
