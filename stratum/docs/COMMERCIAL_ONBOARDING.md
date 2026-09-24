# COMMERCIAL_ONBOARDING.md — Onboard a Design Partner to the Deployed Product

The operational runbook for the commercial pipeline: deploy → mint a key → the partner integrates →
their usage appears → send the invoice → collect payment. This is the path to **v1.0.0** ("first real
invoice sent + paid by a design partner"). Every command/endpoint below is implemented + tested; the
only steps that need an external account are flagged **[needs: …]**.

The business side (finding/qualifying/running a partner) is in `DESIGN_PARTNER.md`. This doc is the
technical "how", current as of the v1.0.0 commercial build.

> **Current deployment boundary (2026-09-24):** the paid Supabase project is
> retired. Local PostgreSQL runs through the project-local Compose stack.
> Commercial billing requires a persistent project-local usage outbox; the old
> Vercel deployment and its ephemeral `/tmp` storage cannot satisfy that gate.
> A public design-partner deployment and payment remain unverified.

---

## 0. The single-partner (pilot) architecture — read first

Per **ADR-0018**, the first partner runs on a **dedicated instance**:

- The server's `ANTHROPIC_API_KEY` is **the partner's own Anthropic key** — so their traffic forwards
  on their key, their Anthropic bill reflects any pruning savings, and CQ bills 20% of that saving.
- The partner authenticates to **us** with a **CQ key** (`cq_…`), which they set as the `apiKey` in
  their Claude Code / Anthropic SDK while pointing `base_url` at the deployed proxy.

So there are two keys: the partner's real Anthropic key lives in the server env (a dedicated instance),
and the CQ key lives in the partner's client config. (Multi-tenant pass-through — no shared instance,
no handing over the Anthropic key — is the documented scale path in ADR-0018, default-off for now.)

---

## 1. Start the local commercial proxy  [needs: a persistent host]

Run the local Compose database and proxy from `stratum/`. The proxy creates
`data/usage-outbox/` with private permissions and replays pending billing events
on startup and every ten seconds. Keep this directory on persistent storage;
back it up alongside the database. A failed disk journal returns an explicit
message error instead of acknowledging unrecorded usage.

```bash
cd stratum
npm run db:start
# Supply provider credentials and CQ_BILLING_SIGNING_SECRET in the operator environment.
CQ_COMMERCIAL=true npm run db:with-env -- npm run dev
```

`db:start` applies the committed migrations. Confirm liveness at
`http://127.0.0.1:4080/health`; commercial mode also checks the database.
The machine-readable contract is at `GET /openapi.json`.

For an external partner, provision a persistent host, a private database, and
a durable volume for the outbox before exposing the proxy. The earlier Vercel
instructions in `docs/VERCEL_DEPLOY.md` are archived because its ephemeral
filesystem cannot recover usage after instance loss.

## 2. Create the partner's org + API key

Create the org with its plan (the plan sets the monthly minimum — starter $0 / growth $99 /
enterprise $499) and mint its first key in one step (the raw key is shown ONCE — give it to the
partner over a secure channel):

```bash
npm run create-org -- --name "<Partner Agency>" --plan growth --with-key
# → org id + cq_live_……  (store the hash only; we cannot recover the raw key)
```

Or create the org alone, then add keys later:

```bash
npm run create-org    -- --name "<Partner Agency>" --plan growth
npm run create-api-key -- --org-id <org-uuid> --name "<Partner> Claude Code"
```

Manage keys later with `npm run api-keys -- --org-id <id> --list | --revoke <key-id>`.

## 3. The partner integrates

They point their Anthropic SDK / Claude Code at the deployed proxy, using the **CQ key** as the apiKey:

```bash
export ANTHROPIC_BASE_URL=https://<host>
export ANTHROPIC_API_KEY=cq_live_……   # the CQ key we minted (NOT their Anthropic key)
claude    # or any Anthropic-SDK app
```

Their requests now flow through `/v1/messages`: authenticated (CQ key → org), forwarded to Anthropic
(on the server's `ANTHROPIC_API_KEY`), measured (exact SDK token counts), rate/budget-limited per their
plan, and **persisted** — each request appends a signed `billing_record` (their usage).

## 4. Confirm their usage is visible

- **API (authenticated with the CQ key — the reliable path):** `GET /v1/billing/invoice`, `GET /v1/billing/summary`, `GET /v1/sessions`.
- **Operator (direct DB read, no HTTP):** `npm run invoice -- --org-id <org-uuid>` — the CFO report + amount due.
- **CFO dashboard** (`https://<host>/billing`): the HTML page is public, but in commercial mode its data fetch is now **auth-gated** — the previous unauthenticated `?org-id` read was a cross-tenant hole, closed in the review-#7 security fix, so the browser dashboard needs auth before it renders data (PB-50: a small dashboard-auth UX follow-up). Until that lands, use the authenticated API or `npm run invoice` above.

> Until pruning is activated (gated on the Tier-A eval — ADR-0009/0014), `quarantined = original`, so
> **savings are $0** and the amount due is the plan minimum. The dashboard truthfully shows usage with
> 0% effectiveness; this is expected pre-pruning. Set `CQ_INPUT_PRICE_PER_TOKEN` to the partner's rate
> before any savings-based billing.

## 5. Send the first invoice  [needs: a Stripe key]

Verify the Stripe integration end-to-end first (one command):

```bash
STRIPE_SECRET_KEY=sk_test_… npm run verify-stripe   # sends a $1 test invoice + checks the webhook path
```

Generate + send the real invoice for the period (the engine floors at the plan minimum):

```bash
npm run invoice -- --org-id <org-uuid> --send   # computes from billing_records; --send goes via Stripe
```

Register the deployed `https://<host>/stripe/webhook` URL in the Stripe Dashboard and set its signing
secret as `STRIPE_WEBHOOK_SECRET`. When the partner pays, Stripe POSTs `invoice.paid` → the webhook
verifies the signature → marks the invoice **paid** in the `invoices` table.

## 6. Confirm payment → v1.0.0 reached

- `GET /v1/billing/invoices?org-id=<org-uuid>&status=paid` shows the paid invoice, or
- query `invoices` directly: a row with `status='paid'` + `paid_at` set.

**That paid invoice is the v1.0.0 acceptance criterion.**

---

## Decision to settle before step 5: free pilot vs. paid pilot

`DESIGN_PARTNER.md` frames a 90-day FREE pilot with payment "when we launch billing". The **v1.0.0**
milestone requires a *paid* invoice. Reconcile these explicitly with the partner: either the pilot
includes a paid subscription minimum from day one (e.g. the growth plan's $99/mo — the first invoice is
that minimum, billable now without pruning), or "first paid invoice" is scheduled for the end of the
free period. The technical pipeline supports either; this is a commercial decision, not a code gap.

---

## Verification commands referenced above

| Command | Purpose |
|---|---|
| `curl https://<host>/health` | Liveness (+ DB dependency in commercial mode) |
| `npm run create-org -- --name "<Org>" --plan <plan> [--with-key]` | Create a partner org (+ optional first key) |
| `npm run create-api-key -- --org-id <id> --name "<label>"` | Mint a CQ key (shown once) |
| `npm run api-keys -- --org-id <id> --list \| --revoke <key-id>` | Key lifecycle |
| `npm run verify-stripe` | TEST-MODE Stripe send + webhook-signature round-trip |
| `npm run invoice -- --org-id <id> [--send] [--csv]` | Compute / send the invoice; audit CSV |
| `npm run verify-billing -- --org-id <id>` | Re-verify every billing record's signature (dispute-proof) |
