# COMMERCIAL_ONBOARDING.md — Local team-mode onboarding

DevOps runs on your own machine, is open source, and has no payment workflow
(owner decision 2026-09-26, ADR-0025). The existing `CQ_COMMERCIAL` setting
enables organization API keys, plan-based resource limits and database-backed
usage. Its name stays unchanged during payment removal.

Payment-removal C1 removes the CFO page, invoice HTTP reads and inbound Stripe
webhook. C2 persists unsigned token usage and estimated USD savings without
`CQ_BILLING_SIGNING_SECRET`. The legacy invoice and Stripe scripts remain
until C3, and the invoice tables until C4. See
[`specs/ops/payment-removal.md`](../../specs/ops/payment-removal.md).

## 1. Start the local proxy

Run the local Compose database and proxy from `runtime/`. The hosted Supabase
project is retired. Configure provider settings in the process environment
before starting; the proxy does not load `.env` files. Team usage persistence
requires database credentials and a persistent outbox, with no signing secret.

```bash
cd runtime
npm run db:start
CQ_COMMERCIAL=true npm run db:with-env -- npm run dev
```

`db:start` applies the committed migrations. When upgrading from C1, stop the
old proxy first and preserve its outbox. Apply M1 and start the C2 writer
together: the old writer needs columns M1 removes, and the new writer cannot
insert into the old signature-required schema. Pending outbox files retain
their format, event ID, occurrence time and pinned price and replay on restart.
Do not downgrade the writer against M1 or delete pending events.

Confirm liveness at
`http://127.0.0.1:4080/health`; `dependencies.database` should be `ok` in team
mode. The machine-readable contract is at `GET /openapi.json` and its browser
view is at `/docs`.

The proxy creates `data/usage-outbox/` with private permissions and replays
pending usage events on startup and every ten seconds. Keep that directory
on persistent storage and back it up alongside the database. A failed disk
journal returns an explicit message error instead of acknowledging unrecorded
usage. Vercel's ephemeral storage is refused for this mode.

The proxy binds loopback by default. See
[API_REFERENCE.md](API_REFERENCE.md#authentication) for the Host, CORS and
authentication requirements if another device needs access.

## 2. Create an organization and API key

The plan controls request rates, token budgets and concurrent-session limits.
Create an organization and its first key together. The raw key is printed
once; only its hash is stored.

```bash
npm run db:with-env -- npm run create-org -- --name "<Team>" --plan growth --with-key
```

Or create the organization and key separately:

```bash
npm run db:with-env -- npm run create-org -- --name "<Team>" --plan growth
npm run db:with-env -- npm run create-api-key -- --org-id '<org-uuid>' --name "Claude Code"
```

Use `npm run db:with-env -- npm run api-keys -- --org-id '<org-uuid>' --list`
to list keys, or replace `--list` with `--revoke '<key-id>'` to revoke one.

## 3. Connect the client

In the client's own shell, point Claude Code or an Anthropic SDK client at the
local proxy and use the organization API key:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4080
export ANTHROPIC_API_KEY='<organization-api-key>'
claude
```

The proxy's process uses its configured provider credentials upstream. Keep
that process separate from the client's shell settings: setting the proxy's
upstream URL to itself is a startup error. Requests to `/v1/messages` are
authenticated, measured and constrained by the organization's resource limits,
and successful usage is journaled before the response completes.

Team-mode responses include `x-cq-conversation-id`. A client that wants later
requests observed in the same shadow context sends that ID as the
`x-cq-conversation-id` request header. The server creates an ID when it is
absent; malformed IDs and IDs belonging to another key or project are rejected
before forwarding. Clients that do not echo it start a fresh observed
conversation on each request. Set `CQ_SHADOW_OBSERVE=true` only when the local
ONNX model cache is installed. Observation does not change model input;
pruning stays disabled until its quality gate passes.

## 4. Read usage

Use an unbound organization key for `GET /v1/billing/summary` and
`GET /v1/billing/records`. A project-bound key receives 403 on both paths.
For example:

```bash
curl 'http://127.0.0.1:4080/v1/billing/summary?month=2026-10' \
  -H 'Authorization: Bearer <organization-api-key>'
curl 'http://127.0.0.1:4080/v1/billing/records?limit=20' \
  -H 'Authorization: Bearer <organization-api-key>'
```

The summary reports token totals, effectiveness and a per-developer token
breakdown. `total_cost_delta_usd` in the summary, `cost_delta_usd` in records,
and `savingsUsd` in session statistics are estimates for information only.
Without active pruning, the usage recorder sets quarantined tokens equal to
original tokens, so savings and effectiveness are zero.

The `/billing` page and `/v1/billing/invoice`, `/v1/billing/audit.csv`,
`/v1/billing/invoices` and `POST /stripe/webhook` are no longer registered.
There is no Stripe endpoint to configure and no payment acceptance step.

## Remaining legacy operator code

`npm run invoice`, `npm run verify-stripe` and `npm run verify-billing` still
exist until C3. After M1, invoice and signature verification commands cannot
process the usage schema: they expect the removed fee/signature columns.
`verify-stripe` exercises the retained library with a test key, not a registered
proxy route. These commands are not part of team onboarding. Invoice tables
remain in backups/restores until C4; session erasure still reports its existing
retention blocker until that cycle changes the erasure boundary. The current v1.0.0 goal is a working
local setup on macOS, Linux and WSL2 (root `plan.md` §9).
