# DEPLOYMENT.md — Production Deployment Guide

## Overview

CQ has three deployment targets that must be coordinated:

1. **Cloudflare Workers** — the proxy, measurement, and routing layer
2. **AWS Nitro Enclave** — the TEE decryption service (ZK-Context only)
3. **Supabase** — managed Postgres (no deployment required, schema migration only)

Pinecone and Neo4j AuraDB are fully managed — no deployment steps beyond provisioning.

---

## Prerequisites

```bash
# Install CLI tools
npm install -g wrangler
npm install -g supabase

# Verify
wrangler --version       # should be 3.x
supabase --version       # should be 1.x
aws --version            # AWS CLI for Nitro Enclaves
```

Accounts required:
- Cloudflare account with Workers paid plan (required for Durable Objects)
- AWS account with EC2 access (for Nitro Enclaves)
- Supabase project (create at supabase.com)
- Pinecone account + index created
- Neo4j AuraDB instance provisioned

---

## Phase 1 Deployment (Measurement Proxy Only)

For Phase 1, deploy is just a Node.js process — no Cloudflare Workers yet.

```bash
# Build
npm run build

# Set production env vars (copy .env.example, fill in real values)
cp .env.example .env.production

# Run
NODE_ENV=production node dist/proxy/index.js
```

For Phase 1 the proxy runs locally on the developer's machine. No cloud deployment needed.

> Note: the app runs the TypeScript source via **tsx** — `npm run build` is `tsc --noEmit` (typecheck
> only; there is no `dist/`). Run it with `tsx src/proxy/index.ts` (= `npm run dev`) or the container below.

---

## Container deployment (recommended for the commercial proxy)

The commercial proxy (and the public Stripe webhook endpoint) needs to run at a **public URL** — for a
design partner to point their Anthropic SDK at it, and for Stripe to deliver `invoice.paid` callbacks.
A `Dockerfile` is provided; the image is portable to any container host (Fly.io, Render, Railway, a VM,
Cloud Run, etc.).

**Build context is the DevOps PARENT** (the proxy imports `@devops/observability/pii-redaction` =
`../observability`), so build from the repo root:

```bash
docker build -f stratum/Dockerfile -t stratum-proxy .

# Personal (measurement) — ANTHROPIC_API_KEY is required just to boot (the proxy forwards to Anthropic):
docker run -p 4080:4080 -e HOST=0.0.0.0 -e ANTHROPIC_API_KEY=sk-ant-… stratum-proxy

# Commercial (multi-tenant auth + billing + Stripe webhook):
docker run -p 4080:4080 -e HOST=0.0.0.0 -e CQ_COMMERCIAL=true \
  -e SUPABASE_URL=… -e SUPABASE_SERVICE_KEY=… -e ANTHROPIC_API_KEY=… \
  -e STRIPE_WEBHOOK_SECRET=whsec_… stratum-proxy
```

- **`HOST=0.0.0.0` is required** in a container — the default bind is `127.0.0.1` (loopback, private by
  default for local use), which is unreachable from outside a container or behind a load balancer.
- The image bakes in `tsx` (the runtime) and exposes a `HEALTHCHECK` on `/health` (public, no key/DB).
- In-memory limiters (rate limit, token budget, webhook retry) are **single-instance** — run ONE
  instance for a single-partner pilot; a multi-instance deploy needs a shared store (tracked, not yet built).
- Register the deployed `https://<host>/stripe/webhook` URL in the Stripe Dashboard; put its signing
  secret in `STRIPE_WEBHOOK_SECRET`. Verify the integration end-to-end with `npm run verify-stripe`.

This image was built + run + health-checked against real Docker (boots in personal mode, `/health` → 200,
container reports `healthy`). The **commercial entry point** was separately verified booting end-to-end
against the real Supabase backend (`CQ_COMMERCIAL=true`, `HOST=0.0.0.0`): `/health` → `200` with
`dependencies.database: "ok"` (live cached health check), `/v1/config` without a key → `401` (auth gate
active), `/openapi.json` → `200` (public) — i.e. every commercial dependency (auth, billing, memory,
sessions, webhooks, token budget, usage recorder, Stripe webhook) constructs + registers without error.
The TEE (Phase 4) + Cloudflare Worker paths below remain account-gated.

---

## Database Deployment (Supabase)

### Initial Setup

```bash
# Link to your Supabase project
npx supabase link --project-ref <your-project-ref>

# Push all migrations
npx supabase db push

# Verify
npx supabase db diff  # should show no diff if migrations applied correctly
```

### Running Migrations After Schema Changes

Every schema change must be a migration file in `supabase/migrations/`. Never alter the production database directly.

```bash
# Create a new migration
npx supabase migration new <description>
# Edit the generated file
npx supabase db push
```

### Rollback

Supabase does not support automatic rollback. If a migration needs to be reversed, write a new migration that undoes the changes. Never delete migration files.

---

## Cloudflare Workers Deployment (Phase 2+)

### First-Time Setup

```bash
# Authenticate
wrangler login

# Create the worker (first time only)
wrangler deploy

# Set secrets (do NOT put these in wrangler.toml)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put PINECONE_API_KEY
wrangler secret put CQ_MASTER_ENCRYPTION_KEY
wrangler secret put AWS_NITRO_ENCLAVE_CID
```

### Deploying Updates

```bash
# Run tests first — never deploy without passing tests
npm run test:all

# Deploy to production
wrangler deploy

# Verify deployment
wrangler tail  # watch live logs
```

### Staging Environment

Always deploy to staging before production:

```bash
# Deploy to staging
wrangler deploy --env staging

# Verify staging works
curl https://startum-proxy-staging.<your-subdomain>.workers.dev/health

# Deploy to production
wrangler deploy --env production
```

Add staging config to `wrangler.toml`:

```toml
[env.staging]
name = "startum-proxy-staging"

[env.production]
name = "startum-proxy"
```

### Durable Objects

Durable Objects require a migration step when the class is first deployed or when new classes are added. The `wrangler.toml` `[[migrations]]` section handles this automatically on deploy.

If you rename a Durable Object class, you must create a new migration entry — renaming in place will cause data loss.

### Rollback

Cloudflare Workers does not support instant rollback via CLI. To roll back:

```bash
# View deployment history
wrangler deployments list

# Roll back to a specific deployment
wrangler rollback <deployment-id>
```

Keep deployment IDs for the last 5 stable releases in `docs/deployment-history.md` (not committed — maintain locally or in your team's ops channel).

---

## AWS Nitro Enclave Deployment (Phase 4+)

### Instance Requirements

- Instance type: `m5.xlarge` or larger (Nitro Enclaves require at least 2 vCPUs and 4GB RAM allocated to the enclave)
- AMI: Amazon Linux 2023
- Nitro Enclaves must be enabled at instance launch — this cannot be changed after launch

### Launch Instance with Nitro Enclaves Enabled

```bash
aws ec2 run-instances \
  --image-id ami-xxxxxxxxx \
  --instance-type m5.xlarge \
  --enclave-options Enabled=true \
  --key-name your-key-pair \
  --security-group-ids sg-xxxxxxxxx \
  --subnet-id subnet-xxxxxxxxx
```

### Build the Enclave Image

```bash
# On the EC2 instance
cd rust/enclave

# Install Nitro Enclaves CLI
sudo amazon-linux-extras enable aws-nitro-enclaves-cli
sudo yum install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel

# Build the enclave image file (.eif)
nitro-cli build-enclave \
  --docker-uri cq-enclave:latest \
  --output-file cq-enclave.eif

# The build output includes PCR measurements — record these:
# PCR0: <hash of enclave image>
# PCR1: <hash of Linux kernel>
# PCR2: <hash of application>
```

### Publish PCR Values

After building, publish the PCR values in `docs/enclave-pcr-values.md` (this file is public — clients use it to verify attestation):

```markdown
## Enclave PCR Values — v0.1.0

Release date: YYYY-MM-DD
Build commit: <git hash>

PCR0: <value>
PCR1: <value>
PCR2: <value>

Verify with:
  nitro-cli describe-enclaves | jq '.[] | .EnclaveID'
  nitro-cli console --enclave-id <id>
```

### Run the Enclave

```bash
nitro-cli run-enclave \
  --cpu-count 2 \
  --memory 4096 \
  --enclave-cid 16 \
  --eif-path cq-enclave.eif \
  --debug-mode false   # NEVER use debug-mode in production (exposes memory)
```

### Enclave Updates

Updating the enclave requires:
1. Build new `.eif` and record new PCR values
2. Publish new PCR values in `docs/enclave-pcr-values.md`
3. Update client libraries with new expected PCR values (new client release)
4. Run old and new enclave in parallel during the transition period
5. Terminate old enclave after client adoption is > 99%

**Never terminate the old enclave before the majority of clients have updated.** Clients with old expected PCR values will reject the new enclave and fail.

---

## Health Checks

After every deployment, verify:

```bash
# Proxy health
curl https://proxy.startum.com/health

# Expected:
# {"status":"ok","proxy":"healthy","supabase":"healthy","pinecone":"healthy","neo4j":"healthy","tee":"healthy"}

# Token counting (sanity check)
curl -X POST https://proxy.startum.com/v1/tokens/count \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"hello"}]}'

# Expected: {"input_tokens": 9}  (or similar small number)
```

---

## Deployment Checklist

Before every production deployment:

- [ ] All tests pass (`npm run test:all`)
- [ ] Eval suite passes if pruning logic changed
- [ ] Staging deployment verified
- [ ] Health checks pass on staging
- [ ] Database migrations applied to staging first
- [ ] Secrets are set in Cloudflare (not in code)
- [ ] PCR values published if enclave was updated
- [ ] Rollback plan documented (which deployment ID to roll back to)
- [ ] Team notified in Slack/Discord: "Deploying vX.X.X to production"

---

## Environment Summary

| Environment | Proxy URL | Supabase | Notes |
|---|---|---|---|
| Local dev | `http://localhost:4080` | Local Docker | `npm run dev` |
| Staging | `https://...-staging.workers.dev` | Staging project | Auto-deploy on `staging` branch |
| Production | `https://proxy.startum.com` | Production project | Manual deploy only |
