# Incident response

Use this runbook when something is wrong with the local Stratum proxy, the
local database, or the graph-engineering pipeline. It covers how to find the
failing part, how to stop the graph, how to handle a blocked cycle, how to
rotate a leaked key, and what clients do while the proxy is down.

Database-level symptoms (Docker, port binding, backup and restore errors) are
in the triage table in [LOCAL_STRATUM.md](LOCAL_STRATUM.md#incident-triage).
This page does not repeat them.

## First moves

1. If a running graph cycle may be doing damage, set the kill switch first
   ([Stop the graph](#stop-the-graph-kill-switch)) and investigate second.
2. If a secret may have leaked, rotate it now
   ([Rotate a leaked key](#rotate-a-leaked-key)). Deleting the file or line is
   not enough once the value has left your control.
3. Otherwise, find the failing part with the checks below.

## Find what is wrong

| Symptom | Check | Next step |
| --- | --- | --- |
| Clients get connection errors | Is the proxy process running? Its startup log line is `CQ Proxy running` with `port`, `host`, and `mode`. | See [When the proxy is down](#when-the-proxy-is-down). |
| Proxy exits at start with `Failed to start CQ Proxy` | Read the `err` field. In commercial mode, startup requires database settings and `CQ_BILLING_SIGNING_SECRET`, and refuses a Vercel environment for billing. | Supply the missing process setting and restart. |
| `/health` answers but requests fail | Read `dependencies.database` in the `/health` body. | If it is `error`, follow the database rows in [LOCAL_STRATUM.md](LOCAL_STRATUM.md#incident-triage). |
| Requests to `/v1/*` get 401 (commercial mode) | The message says the key is missing, or `invalid or inactive API key`. The gate accepts only active keys. | `npm run api-keys -- --org-id <uuid> --list` through `db:with-env`; mint a new key if needed ([COMMON_TASKS.md](COMMON_TASKS.md#mint-an-api-key)). |
| Log shows `getOrgPlan failed — defaulting to starter tier` | The plan lookup failed for that organization, so it is rate limited at the starter tier. If the database is unreachable, every organization is. | Check the database as above. |
| Log shows `usage outbox replay failed` | Usage events are queued on disk and not yet written to `billing_records`. | Check the database. Do not delete the outbox directory. |
| `/sprint` refuses to start | Run `bash scripts/graph-preflight.sh` and read the failing check IDs. | See [Blocked graph cycles](#blocked-graph-cycles). |

Sources: `stratum/src/proxy/index.ts:116-121`, `stratum/src/proxy/index.ts:155-164`,
`stratum/src/proxy/index.ts:198-201`, `stratum/src/proxy/index.ts:269-280`,
`stratum/src/proxy/auth.ts:73-78`, `stratum/src/proxy/auth.ts:98-100`,
`stratum/src/proxy/auth.ts:131-134`, `stratum/src/proxy/routes/health.ts:29-43`,
`slash-commands/universal/sprint.md:14-21`.

### Proxy health

The proxy serves `GET /health` without authentication. It listens on
`127.0.0.1:4080` unless `HOST` or `PORT` is set.

- `status` is always `"ok"` while the process answers. It does not mean the
  database is reachable.
- `dependencies.database` (`"ok"` or `"error"`) is present only in commercial
  mode. The result is cached for 5 seconds.
- In personal mode, `/health` is liveness only.

To check the proxy and the local database together from a script, run the
same smoke check that `npm run setup` uses. It starts its own proxy instance on
a random loopback port, calls `/health`, requires
`dependencies.database === "ok"`, and prints
`Proxy listener and local database health: ok`. Run it from `stratum/`:

```sh
npm run db:with-env -- tsx scripts/smoke-setup.ts
```

This checks the code and the database. It does not check a proxy process
that is already running.

Sources: `stratum/src/proxy/routes/health.ts:1-8`, `stratum/src/proxy/routes/health.ts:29-43`,
`stratum/src/proxy/routes/health.ts:58-72`, `stratum/src/proxy/index.ts:104-107`,
`stratum/src/proxy/index.ts:164`, `stratum/src/proxy/index.ts:225`,
`stratum/src/proxy/auth.ts:110`, `stratum/scripts/smoke-setup.ts:7-36`,
`scripts/setup-local.mjs:40`.

### Logs

The proxy logs JSON lines to standard output through pino. There is no log
file; capture the process output if you need to keep it. `LOG_LEVEL` sets the
level (default `info`). `NODE_ENV=development` switches to pretty output.

The local database, REST, and gateway containers belong to the Compose project
`devops-stratum-compose` (or `devops-stratum-isolated-<instance>`), defined by
`stratum/supabase/docker-compose.local.yml`. Their logs are Docker container
logs; no repository script reads them. When `npm run db:start` fails, its
error already names the failed stage and each container's state and exit
code, and it does not print Docker's own error text because that can include
the JWT secret.

The graph pipeline appends events to `.workflow/state/events.jsonl`, including
`deploy_gate_block`, `graph.blocked`, and `graph.environment_fault`. The
read-only dashboard (`npm run graph:dashboard`, default
`http://127.0.0.1:4081`) shows a halt banner and the events file, newest first. It has no
control that halts, resumes, or approves anything.

Sources: `stratum/src/lib/logger.ts:10-18`, `stratum/scripts/local-compose.ts:14-26`,
`stratum/scripts/local-compose.ts:48-62`, `stratum/scripts/local-compose.ts:150-154`,
`hooks/universal/pre-tool/deploy-gate.sh:70-74`, `scripts/graph-blocked.sh:86-87`,
`package.json:19`, `scripts/graph-dashboard/README.md:29`,
`scripts/graph-dashboard/README.md:81-83`, `scripts/graph-dashboard/README.md:109-113`,
`scripts/graph-dashboard/README.md:137-147`.

## Stop the graph (kill switch)

`/graph-halt` and `/graph-resume` are defined in `slash-commands/universal/`,
but only `/sprint` is registered with Claude Code in this checkout. Run their
steps directly from the repository root.

Halt:

```sh
mkdir -p .workflow/state
echo '{"ts":'"$(date -u +%s)"',"halted_by":"<your identifier>","reason":"<why>"}' \
  > .workflow/state/graph-halt
```

The deploy gate is a Claude Code `PreToolUse` hook on the `Bash` tool. It
sees only the command text of Bash tool calls in Claude Code sessions that use
this checkout's `.claude/settings.json`. It does not block a command that a
person types in their own terminal. It does not block a non-Bash tool, such
as an MCP tool that pushes files or creates a deployment. The halt file is
therefore not a repository-wide block on pushes or deploys.

While `.workflow/state/graph-halt` exists:

- The deploy gate blocks every Bash tool command that its pre-filter matches:
  `vercel`, `wrangler`, `npm publish`, `git push`, `git commit`, and
  `git tag`. It does not block other commands, so you can still inspect the
  repository.
- `scripts/graph-preflight.sh` fails its `halt.absent` check, so `/sprint`
  refuses to launch or resume a cycle.
- A cycle already past preflight keeps running. Only its matched commands are
  blocked.
- Nothing already done is rolled back.

Resume, only after a human has confirmed the cause is fixed (the command
performs no check of its own):

```sh
rm -f .workflow/state/graph-halt
echo '{"ts":'"$(date -u +%s)"',"event":"graph_resume"}' >> .workflow/state/events.jsonl
```

An agent must never remove the halt file; only the user clears it.

Sources: `CLAUDE.md:89-91`, `slash-commands/universal/graph-halt.md:9-28`,
`slash-commands/universal/graph-resume.md:9-17`, `.claude/settings.json:24-36`,
`hooks/universal/pre-tool/deploy-gate.sh:29`, `hooks/universal/pre-tool/deploy-gate.sh:32`,
`hooks/universal/pre-tool/deploy-gate.sh:77-106`,
`scripts/graph-preflight.mjs:223-225`, `slash-commands/universal/sprint.md:20-21`.

## Blocked graph cycles

When a cycle stops on an environment, API, transient, or human-action fault,
the orchestrator runs `scripts/graph-blocked.sh`. It writes
`.workflow/state/blocked.md` (mode 0600) and appends `graph.blocked` and
`graph.environment_fault` to `.workflow/state/events.jsonl`. The record has
these sections: What happened, Class, Impact, Fix, Resume, Evidence, and Run
record. Evidence is the first 20 lines of a project-local file, with common
key and token shapes redacted. The script refuses `.env`, `.pem`, and `.key`
evidence files and paths outside the project.

To handle a block:

1. Read `.workflow/state/blocked.md`. The `## Class` line says who acts.
2. `api` and `transient`: no fix is needed. The cycle can resume when the API
   is back.
3. `environment`: the default fix is `bash scripts/graph-preflight.sh`. Run it
   and read the failing check IDs. Exit 0 means ready, 10 means it applied a
   registered repair, 20 means a check still fails, and 2 means preflight
   itself errored. Use `--check-only` to report without repairing.
4. `needs_human`: the Fix section holds the exact human action, followed by
   `rm -- .workflow/state/blocked.md`. Perform the action, then remove the
   file. Preflight's `blocked.human` check fails while a `needs_human` record
   exists.
5. Resume with `/sprint --resume <cycleId>`. It runs preflight again; exit 20
   or 2 leaves the block record and run record unchanged.

Sources: `scripts/graph-blocked.sh:16-46`, `scripts/graph-blocked.sh:55-88`,
`scripts/graph-preflight.mjs:228-236`, `scripts/graph-preflight.mjs:267-268`,
`scripts/graph-preflight.mjs:300`, `scripts/graph-preflight.mjs:312`,
`slash-commands/universal/sprint.md:47-72`.

## Rotate a leaked key

| Secret | Where it lives | How to rotate |
| --- | --- | --- |
| Stratum API key (`cq_live_…` or `cq_test_…`) | Only its SHA-256 hash is stored, in `api_keys`. | Revoke it and mint a replacement ([COMMON_TASKS.md](COMMON_TASKS.md#revoke-an-api-key)). |
| Provider key (for example `ANTHROPIC_API_KEY`) | The proxy's process environment. | No repository script rotates it. Revoke and reissue it with the provider, then restart the proxy with the new value. |
| `CQ_BILLING_SIGNING_SECRET` | The proxy's process environment. | No repository script rotates it. Restart the proxy with a new value. See the note below. |
| `STRIPE_WEBHOOK_SECRET` | The proxy's process environment. | No repository script rotates it. Rotate it in Stripe, then restart the proxy. |
| Local service JWT | Generated by `db:with-env`, valid 24 hours. | `npm run db:stop`, then `npm run db:start`. Start signs with a new random secret, so older JWTs stop working. Start any `db:with-env` process again afterwards. |

Revocation of a Stratum API key takes effect on the next request. The gate
looks up the key hash among active keys on every request and keeps no cache.
The key list does not show real use: `last_used` is not written per request.

Billing records are signed with `CQ_BILLING_SIGNING_SECRET`.
`npm run verify-billing` checks records against one secret, so records signed
before a rotation will not verify with the new secret. Use its `--since` and
`--until` options to verify each period with the secret that signed it.

If you restore a backup taken before a revocation, the revoked key is active
again. Revoke it again after the restore
([BACKUP_RESTORE.md](BACKUP_RESTORE.md#what-a-restore-does)).

A secret committed to Git stays in history after the file is changed. Rotate
it.

Sources: `stratum/src/proxy/auth.ts:33-42`, `stratum/src/proxy/auth.ts:66-83`,
`stratum/scripts/api-keys.ts:1-9`, `stratum/scripts/api-keys.ts:58-65`,
`stratum/src/proxy/index.ts:13-17`, `stratum/src/proxy/index.ts:166-168`,
`stratum/src/proxy/index.ts:195-197`, `stratum/src/proxy/providers/router.ts:80-82`,
`stratum/scripts/verify-billing.ts:1-9`, `stratum/scripts/verify-billing.ts:95-108`,
`stratum/scripts/local-compose.ts:134-136`, `stratum/scripts/local-compose.ts:157-159`,
`docs/runbooks/LOCAL_STRATUM.md:117`.

## When the proxy is down

The proxy does not fall back on its own. A client pointed at it gets errors.
`stratum/docs/FAQ.md:37` states this and recommends a client-side fallback:
send the request directly to the provider (`api.anthropic.com`).

For Claude Code, the client uses the proxy only when `ANTHROPIC_BASE_URL`
points at it in the client's own shell. To bypass the proxy, start the client
from a shell where `ANTHROPIC_BASE_URL` is not set. Requests then go straight
to the provider.

Requests that bypass the proxy are not seen by it. They create no usage
record, no message-memory capture, and no dashboard entry. Pruning is not
active in requests, so bypassing does not change what the model receives.

The proxy reads the database only in commercial mode. Commercial mode needs
`CQ_COMMERCIAL=true` (or `1`) together with `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY`. `db:with-env` supplies only `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, and `DEVOPS_STRATUM_PROJECT_ROOT`. It passes the rest
of the shell environment through unchanged. Without `CQ_COMMERCIAL`, the proxy
starts in personal mode. Personal mode has no API-key gate, no database
client, and no usage recording, and `/health` has no `dependencies` field.
The 401 and `dependencies.database` rows above apply only to commercial mode.

To restart the commercial proxy against the local database:

1. In the shell, set the provider settings, and set
   `CQ_BILLING_SIGNING_SECRET`. Commercial startup refuses to run without it.
   Use the value that signed the existing billing records unless you are
   rotating it ([Rotate a leaked key](#rotate-a-leaked-key)). The proxy does
   not load `stratum/.env`. Do not put the secret in a command line or a
   project file.
2. From `stratum/`, run:

   ```sh
   CQ_COMMERCIAL=true npm run db:with-env -- npm run dev
   ```

3. Wait for the `CQ Proxy running` line. Its `mode` field must read
   `commercial (multi-tenant auth + APIs)`. If it reads
   `personal (Phase 1 measurement)`, `CQ_COMMERCIAL` did not reach the
   process. Stop the proxy and fix the environment.
4. Point the client back at the proxy only after step 3 passes.

Sources: `stratum/docs/FAQ.md:37`, `CLAUDE.md:175-183`,
`stratum/src/proxy/index.ts:13-17`, `stratum/src/proxy/index.ts:109-121`,
`stratum/src/proxy/index.ts:135-164`, `stratum/src/proxy/index.ts:189-213`,
`stratum/src/proxy/index.ts:226-242`, `stratum/src/proxy/index.ts:271`,
`stratum/scripts/local-compose.ts:157-162`,
`stratum/docs/COMMERCIAL_ONBOARDING.md:100`,
`stratum/docs/MEMORY_AND_EVAL_COMMANDS.md:11-12`.
