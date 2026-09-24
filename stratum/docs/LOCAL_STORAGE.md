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

For a second checkout on the same host, set both `DEVOPS_LOCAL_INSTANCE` to a
short lowercase label and `DEVOPS_LOCAL_PORT` to a free, distinct loopback
port (1024–65535) before `npm run setup`. Use the same two values when running
`npm run db:stop` from that checkout. The alternate Compose project, container
names, and database volume are separate from the default stack; the proxy
smoke checks its selected port. Omit both settings for the usual 54321 stack.

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
It seeds unbound, same-organization project, suppressed, and foreign
organization facts. It verifies that the actual bridge returns only the
operator-bound project's fact and that semantic ranking filters by project
before its limit, then removes the fixture. Set `DEVOPS_STRATUM_PROJECT_SCOPE`
to the same lowercase project slug used when creating that project's API key;
an absent value recalls only unbound legacy facts. An invalid value skips
recall before connecting. This setting supplements the required project root
and `DEVOPS_STRATUM_ORG_ID` binding. Run
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

Run `npm run db:verify-project-scope` after migrations to check operator-bound
API key project identity. Create a key with
`npm run db:with-env -- npm run create-api-key -- --org-id <uuid> --name <label> --project-scope <slug>`.
Use a separate key for each project. The trusted request scope is the
authenticated organization plus the stored slug; client headers and query
parameters cannot change it. Existing keys without `--project-scope` remain
unbound and cannot supply a scoped pruning decision. Pruning remains disabled.

Run `npm run db:verify-project-warm-facts` to check project-scoped memory
sessions, typed facts, and the fact read/suppress API against the local database.
Bound keys see only their own project's structured facts; unbound keys see only
legacy unbound facts. The database rejects a fact whose project differs from
its session. Graph, audit-status, and other organization-wide APIs are not yet
project-isolated. This does not enable pruning.

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
Set `REAL_MODEL_CASE=variable` for an explicit `JWT_TTL_MINUTES` 60-to-15
change; the check requires string values in the stored `VariableChange` and
recalls the same fact through SessionStart.

Run `npm run db:verify-graph-read` to verify the protected, bounded
`/v1/memory/graph` snapshot against two disposable local organizations. It
checks key-based scope and bounded node/edge reads. The graph schema now
rejects cross-organization edge references. Run
`npm run db:verify-graph-integrity` to check insert and update rejection for
foreign entity and session references. The read API supplies graph nodes and
edges. Run `npm run db:verify-source-graph` for a disposable source fixture
round-trip and idempotence check. To ingest a selected project-local JS/TS/Rust/Python
subtree for an existing organization, set `INGEST_ORG_ID` to its UUID, optionally
set `SOURCE_SUBDIR` (default `stratum/src`), and run
`npm run db:with-env -- npm run ingest-source-graph` from `stratum/`. This creates
File and top-level Function nodes with source-derived summaries plus DECLARES
and local import/module DEPENDS_ON edges. Rust ingestion recognizes top-level
named functions and `mod name;` declarations; Python ingestion recognizes
top-level sync/async functions and known local imports. It also replaces their entity embeddings
using the project-local ONNX cache; a missing cache fails without downloading.
To generate optional File summaries with a local OpenAI-compatible text model,
set `CQ_SOURCE_SUMMARY_MODEL=local/<model>` and `CQ_LOCAL_BASE_URL` to a literal
loopback HTTP `/v1` endpoint before running that ingestion command. The model
receives at most 3,000 characters of each File as marked untrusted data, and
its one-sentence response must pass the summary safety and length checks.
The request asks reasoning-capable local models for non-thinking output so the
96-token reply budget can carry the sentence; explicitly truncated replies
are rejected. With an already-running local model, run the bounded quality
sample from `stratum/`:

```sh
DEVOPS_STRATUM_PROJECT_ROOT="$(cd .. && pwd)" CQ_LOCAL_BASE_URL=http://127.0.0.1:1234/v1 \
  CQ_SOURCE_SUMMARY_MODEL=local/qwen-local npx tsx test/integration/real-source-summary-sample.ts
```

Adjust the loopback port and local model ID to match the running server. The
sample reads 11 project Files across JS/TS, Rust, and Python and makes no
database writes.
For a disposable real-model persistence and Chrome check, run the same model settings
through `npm run db:with-env -- npx tsx
test/integration/local-real-source-graph.ts` from `stratum/`; it verifies two
File summaries, four embeddings, their display in a scoped sidebar and tour,
foreign-organization exclusion, and fixture cleanup in local Compose. Chrome
must be installed.
The ingestor completes and validates all summaries before graph writes; an
invalid response fails the run. Function summaries remain source-derived.
Without `CQ_SOURCE_SUMMARY_MODEL`, the deterministic summaries remain, even
when `CQ_LOCAL_BASE_URL` is used for another local feature. Reingestion without
the summary model will restore those deterministic File summaries. A local
fixture verifies wiring. The 11-File real-model sample and disposable
persistence check are bounded evidence, not a representative accuracy score
for arbitrary project source.

Open `/dashboard/graph` on the local proxy to explore the bounded graph
snapshot. Enter a CQ API key in commercial mode, or pass `?org-id=<uuid>` in
personal mode. The view shows up to 500 current nodes, their in-snapshot edges,
source paths and summaries; selecting a node reveals its neighbors. It warns
when the snapshot may be truncated. Its search box offers scoped fuzzy name and
semantic modes to find nodes beyond that snapshot and reveal their immediate
neighbors. Start tour loads every organization File and DEPENDS_ON page, then
shows dependencies before files that import them with Previous/Next controls.
Run `npm run db:verify-graph-search` for a disposable 501-file/500-edge search
and traversal check, and `npm run db:verify-graph-semantic` for scoped vector
ranking and stale-pointer filtering. Selecting a File or source Function also loads active
Tier-2 changes and decisions whose path exactly matches that indexed File.
`source_fact_links` persists those typed File-to-fact edges. Database triggers
sync both insert orders, suppression, path changes, and deletion; the API still
checks active status. Run `npm run db:verify-graph-related-facts` for the local
two-organization lifecycle check and `npm run db:verify-source-fact-backfill`
for a disposable pre-migration backfill and privilege check.
Run `npm run verify:graph-browser` on a machine with local Chrome to exercise
the served dashboard and scoped API through a real browser. It uses an isolated
in-memory fixture and saves `.workflow/proofs/graph-browser.png` and
`.workflow/proofs/graph-browser-fact-node.png`. Selecting an indexed File adds
up to 50 active linked facts as selectable canvas nodes. Reselect the File to
refresh them after suppression; a changed response removes stale nodes and
links. Selecting a source Function keeps the sidebar relation without implying
a Function-to-fact canvas edge. The tour narrates each File's source summary
and direct dependency direction using bounded, literal text from the scoped
graph pages. Name and offline semantic node search are available in the view.

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
