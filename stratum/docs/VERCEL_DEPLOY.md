# Vercel deployment (commercial proxy)

The proxy is a long-running Fastify server; on Vercel it runs as a single **Node serverless function**
(`api/index.js`) that wraps the same app `src/proxy/index.ts` builds and feeds each request into Fastify
via `app.server.emit("request", …)`. The function is **esbuild-bundled** so the one cross-subtree import
(`@devops/observability/pii-redaction`, which lives outside `stratum/`) is inlined — Vercel never needs
files outside `stratum/`. Verified booting locally in commercial mode against real Supabase (`/health`
→ `database: ok`, the auth gate 401s, the percent-encoding bypass fix is in the bundle).

## What is automated vs. what needs you

Prepared + committed (reproducible): the bundle entry (`vercel-src/entry.ts`), `npm run build:vercel`
(esbuild), `vercel.json` (routes all paths to the function, `maxDuration: 300`, lean install of only the
9 runtime deps the function actually imports), and `.vercelignore` (**`.env` is excluded — secrets are
never uploaded**).

Needs you (no MCP tool / the Vercel CLI is not installed for these):
1. **`vercel login`** — authenticate the CLI (interactive).
2. **Set the env vars** (Vercel encrypted store — never in the repo).
3. Run **`vercel deploy --prod`**.

> Tip: you can run these in this session by typing `! <command>` so the output lands here.

## Steps

```bash
# 0. one-time: install + login (the CLI is not installed)
npm i -g vercel
vercel login                      # interactive (opens the browser)

# 1. build the self-contained function bundle (must run locally — it inlines ../observability)
cd stratum
npm run build:vercel              # → api/index.js

# 2. link + set the production env vars (encrypted; values from your .env)
vercel link                       # pick the team "milton's projects", create project e.g. "stratum"
vercel env add ANTHROPIC_API_KEY        production   # paste the value
vercel env add SUPABASE_URL             production
vercel env add SUPABASE_SERVICE_KEY     production
vercel env add CQ_BILLING_SIGNING_SECRET production  # enables usage → billing_records
printf 'true' | vercel env add CQ_COMMERCIAL  production   # multi-tenant auth + APIs
printf '/tmp' | vercel env add CQ_CAPTURE_DIR production   # serverless fs is read-only except /tmp
# later, once you register the Stripe webhook endpoint:
# vercel env add STRIPE_WEBHOOK_SECRET   production   # whsec_… → enables POST /stripe/webhook

# 3. deploy
vercel deploy --prod              # uploads api/index.js + vercel.json (NOT .env)

# 4. verify the live URL (replace <url> with the deployment URL printed above)
curl -s https://<url>/health                                   # → 200 {"database":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://<url>/v1/billing/invoice   # → 401 (auth gate)
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is 'https://<url>/%76%31/billing/invoice'  # → 401 (bypass closed)
```

## Required env vars

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | required to boot (the proxy forwards to Anthropic) |
| `CQ_COMMERCIAL=true` | multi-tenant auth gate + config/memory/billing/sessions/webhooks APIs |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | the multi-tenant store |
| `CQ_BILLING_SIGNING_SECRET` | persists usage as signed `billing_records` (the invoice basis) |
| `CQ_CAPTURE_DIR=/tmp` | the capture store's writable dir on a read-only serverless fs |
| `STRIPE_WEBHOOK_SECRET` | (later) enables the inbound `invoice.paid` webhook |

## Caveats on Vercel serverless (vs. the Dockerfile container path)

- **Streaming `/v1/messages` is bounded by the function time limit (≈300s on Hobby/Pro default).** Typical
  Claude Code turns finish well under it, but a very long agentic stream can be cut off. The **non-streaming
  billing / invoice / Stripe-webhook path — what the v1.0.0 "invoice sent + paid" acceptance needs — is
  unaffected.** A container host (the verified `Dockerfile`) has no such cap and is the better fit for the
  streaming proxy if long-stream truncation becomes an issue.
- **In-memory rate/token limiters are per-instance.** Fluid Compute reuses instances but may run several;
  the caps are approximate across instances (already a documented limitation).
- **Verify the Stripe webhook RAW body** once `STRIPE_WEBHOOK_SECRET` is set — the HMAC is over exact bytes,
  and a serverless platform that pre-buffers the body could break it. The `app.server.emit` path passes the
  unconsumed stream to Fastify's own raw-body parser; confirm with a Stripe test event after going live.
