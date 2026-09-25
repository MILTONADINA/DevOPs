# Stratum — Memory & Eval Commands (v0.4.x / v0.5.x / v0.6.x)

Operator guide for the three-tier memory + the pruning-eval tooling. Each command
is marked **FREE** (local ONNX encoder + local Supabase Compose stack — no Anthropic
spend) or **NEEDS CREDITS** (calls the Claude judge/extractor — costs Anthropic API
credits).

The paused hosted Supabase project is retired. See [LOCAL_STORAGE.md](LOCAL_STORAGE.md)
for the local database setup and its release limits.

> The Phase-1 measurement proxy is documented separately in `PERSONAL_USE.md`.
> Pruning is **not** wired into the request path (constitution / ADR-0009) — it
> ships only after the judged Tier-A eval passes.

---

## Setup

```bash
cd DevOPs
npm run setup            # install missing Stratum deps; start local Compose; smoke-test proxy/DB
```

`npm run setup` at the repository root or inside `stratum/` uses the same local
workflow. It does not read or create `.env` files. The proxy smoke check uses
the local database; provider-backed messages need a configured provider.
Clean-machine and cross-platform timing gates remain open.

`npm run backup -- --org-id <uuid> [--pretty]` exports one org's full row-set across all
23 tables to a timestamped JSON in the gitignored `backups/` (disaster recovery / data
portability / GDPR export). **FREE**, read-only (SELECT only); needs Supabase creds.
`npm run restore -- --file <path> [--dry-run] [--keep-key-state]` re-inserts a backup (API keys come back inactive unless `--keep-key-state`) in FK-dependency order
— preserving UUIDs (so cross-table references stay valid) and stripping billing's generated
columns — into a CLEAN target. A disposable local backup → delete → restore
round-trip is referential-integrity-verified; real-data recovery is unverified.

`npm run invoice -- --org-id <uuid> [--since <iso>] [--until <iso>] [--csv <path>] [--send]`
computes an org's **token-arbitrage invoice** (BUSINESS_MODEL.md: 20% of savings, with the
plan's monthly-minimum floor) from its append-only `billing_records` and prints the CFO
report; `--csv` writes the signed-hash audit trail. **FREE**, read-only. The Stripe **send is
implemented** (`src/billing/stripe.ts`: customer → invoiceitem → invoice → finalize, behind the
InvoiceSink seam, fake-fetch-tested incl. dollars→cents; a `sk_live_` key is refused until verified
in test mode), and the **inbound `invoice.paid` webhook** (`POST /stripe/webhook`, signature-verified)
records payment into the `invoices` table. `npm run verify-stripe` is the one-command TEST-MODE check:
given a `sk_test_` key it sends a $1 test invoice against the real Stripe API and round-trips the
webhook signature/routing; **gated-skip without a key** (never fabricates). An actual paid invoice
still needs a deployed endpoint + a design partner.

Billing records are **HMAC-signed** (src/billing/recorder.ts: `recordBilling` signs each row's
immutable inputs with `CQ_BILLING_SIGNING_SECRET`; the generated columns are DB-derived). `npm run
verify-billing -- --org-id <uuid>` recomputes every record's signature and flags any tampering —
the dispute-proof check ("we provably cannot retroactively modify the data"). **FREE**, read-only.
It uses only explicit process environment settings and exits nonzero when
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, or `CQ_BILLING_SIGNING_SECRET` is missing;
an unset verifier is not a passing integrity check.

The proxy also exposes the **CFO billing API** when `buildProxy({ billing })` is supplied:
`GET /v1/billing/invoice` (the computed Invoice JSON) and `GET /v1/billing/audit.csv` (the
signed-hash audit trail download) — org-scoped via the auth gate (or `?org-id`). It composes
the same invoice engine + read path as `npm run invoice`.

Other opt-in proxy APIs (all org-scoped via the auth gate): **config** (`buildProxy({ config })`)
— `GET`/`PATCH /v1/config` for pruning params (λ/θ/gain_shift) + flags; **memory**
(`buildProxy({ memory })`) — `GET /v1/memory/facts`, `DELETE /v1/memory/facts/:id?table=`
(suppress), `GET /v1/memory/conflicts`; **sessions** (`buildProxy({ sessions })`) — `GET
/v1/sessions`, `/:id`, `/:id/stats` (token totals + savings, with cross-tenant isolation). Each
takes an injectable deps object (a fake in tests; a `createSupabase*Deps(client)` helper in prod)
and is omitted by default.

Billing also exposes (per `docs/API_REFERENCE.md`): `GET /v1/billing/summary` (`?month=YYYY-MM`),
`GET /v1/billing/records` (paginated raw records), and `POST /v1/tokens/count` (`buildProxy({ tokens })`
— exact token count for a `{model, messages}` body without proxying).

**Webhooks** (`buildProxy({ webhooks })`): `POST /v1/webhooks/test` sends a signed sample event
(6 types per `docs/WEBHOOKS.md`) to the org's configured `webhook_url`. Every event carries an
`X-CQ-Signature: sha256=<hmac>` header (HMAC-SHA256 of the body, per-org `webhook_secret`); delivery
is **SSRF-guarded** (rejects localhost / private / cloud-metadata targets). Set the url + secret via
`PATCH /v1/config`.

**Commercial mode:** `CQ_COMMERCIAL=true npm run dev` (with Supabase creds set) boots the proxy
with the multi-tenant auth gate (protecting `/v1/*`) + all of the above APIs wired over Supabase —
mint a key with `npm run create-api-key`, then call `/v1/*` with `Authorization: Bearer <key>`.
Without the flag, the proxy is the unauthenticated Phase-1 personal measurement server (unchanged).

`npm run create-org -- --name "<Org>" --plan starter|growth|enterprise|custom [--with-key]` creates a
partner org (the plan sets the invoice monthly-minimum floor) and, with `--with-key`, mints its first
API key in one step — the onboarding entry point (`COMMERCIAL_ONBOARDING.md`). **FREE**.

`npm run create-api-key -- --org-id <uuid> --name "<label>" [--env test]` mints a multi-tenant
API key, stores **only its SHA-256 hash** in `api_keys` (a DB leak never exposes usable keys),
and prints the raw key once. The proxy enforces it when `buildProxy({ auth })` is supplied
(opt-in — the personal-use proxy stays unauthenticated): every non-`/health` request must send
`Authorization: Bearer <key>` (or `x-api-key`), and its org is attached to `req.orgId`. **FREE**.
`npm run api-keys -- --org-id <uuid> --list` lists an org's keys (never the secret/hash); `--revoke
<key-id>` deactivates one — the auth gate (which filters `is_active=true`) rejects it immediately.

Add to `stratum/.env` (gitignored — never commit):

```
SUPABASE_URL=https://<project>.supabase.co        # free-tier project is fine
SUPABASE_SERVICE_KEY=sb_secret_...                # service-role key (bypasses RLS)
ANTHROPIC_API_KEY=sk-ant-...                       # ONLY for the NEEDS-CREDITS commands
```

The schema lives in `supabase/migrations/` (already applied to the live project).
The ONNX embedding model (~23 MB) downloads once to the gitignored `models/` on the
first command that encodes.

---

## Memory commands

| Command | Cost | What it does |
|---|---|---|
| `npm run verify-tier2` | **FREE** | Tier-2 warm-memory adapter round-trip against live Supabase (insert → read → cleanup). Skips cleanly without Supabase creds. |
| `npm run promote` | **FREE** | Nightly Tier-2 → Tier-3 promotion: unpromoted facts → graph entities/edges + vectors (offline encoder), marks `promoted_to_t3`. Env: `PROMOTE_OLDER_THAN_DAYS` (default 30; `0` = all), `PROMOTE_LIMIT` (500), `PROMOTE_ORG_ID` (default: all orgs). Idempotent. |
| `npm run understand-codebase -- --org "<name>" --entity <name>` | **FREE** | `/understand-codebase` query: an entity's status (superseded / supersedes / deprecated / referenced) from the Tier-3 graph. |
| `npm run understand-codebase -- --org "<name>" --query "<text>" [--k N]` | **FREE** | Semantic search over the vector store (local query encoding); resolves each hit to its typed-fact content. Combinable with `--entity`. Use `--org-id <uuid>` to skip the name lookup. |
| `npm run bench:tiers` | **FREE** | Tier-latency benchmark vs the documented targets (Tier-1 hot sub-ms, pruner p99 < 20ms, Tier-2 p95 < 80ms, Tier-3 p95 < 200ms). Tier-2/3 run only with Supabase creds (seed throwaway org → measure → delete). |
| `npm run smoke:memory` | **NEEDS CREDITS** | Full pipeline END-TO-END: real Claude-Haiku extraction → warm persist → Tier-3 promote → recall. Proves ingestion; self-cleans. |

Ingestion (turning real sessions into facts via the extractor) is the one
**NEEDS CREDITS** part of the memory loop — everything that stores, promotes,
queries, or benchmarks *existing* facts is FREE.

Claude SessionStart also runs the read-only Stratum memory bridge when the
operator supplies `DEVOPS_STRATUM_PROJECT_ROOT` (this project's real path),
`DEVOPS_STRATUM_ORG_ID` (the trusted organization UUID), `SUPABASE_URL`, and
`SUPABASE_SERVICE_KEY` in the process environment. The Supabase hostname must
be in `.workflow/network-allowlist.txt`; the bridge does not read `.env`.
For the approved local stack, use `SUPABASE_URL=http://127.0.0.1:54321`
after `npm run db:start` passes its loopback check. Other plaintext URLs are
rejected; remote origins still require HTTPS and an allowlisted host.
It emits at most three recent and three semantic typed facts as untrusted data.
The semantic query comes from the baton's Next action and uses only the local
cached model; if the model is absent, recent facts still appear with
`semanticStatus: "unavailable"`. Missing binding or runtime skips recall
without blocking startup.

---

## Eval / pruning-gate commands

The accuracy gate decides whether pruning may ship (constitution: <5% Faithfulness
degradation + evidence survival, on published Tier-A benchmarks). The **judged**
runs use a Claude judge for the release gate. An explicitly configured local
OpenAI-compatible model can run an exploratory comparison at no API cost; its
scores do not replace the Claude gate. The **survival** sweeps are FREE
(evidence survival is a deterministic function of the prune decision).

| Command | Cost | What it does |
|---|---|---|
| `npm run eval:locomo:survival` | **FREE** | LoCoMo evidence-survival sweep (local ONNX only): absolute-λ vs scale-invariant decay, all conversations. |
| `npm run eval:longmemeval:survival` | **FREE** | Same, on LongMemEval (the 2nd long-horizon benchmark). |
| `npm run eval:tierc` | **FREE** | Real cached ONNX encoder + KadaneDial over 50 synthetic critical golden queries; returns nonzero for any missing or leaked anchor. Current default result: 20/50, RED. |
| `npm run test:eval -- --fast` | **NEEDS CREDITS** | Runs Tier-C first, then judged Tier-B only if Tier-C passes. Missing provider or red gate exits nonzero; local judgment stays exploratory. |
| `npm run eval:locomo` | **NEEDS CREDITS** | Judged LoCoMo Tier-A gate (real encoder + Claude judge): faithfulness/relevancy + evidence co-gate. Env: `LOCOMO_CONVERSATIONS`, `LOCOMO_QUESTIONS`, `LOCOMO_LAMBDAS`, `LOCOMO_DECAY_HORIZON_FRAC` (scale-invariant decay, ADR-0015), `LOCOMO_REPEATS` (R samples/scenario, averaged — judge-noise damping, PB-42; default 1; cost scales ×R). |
| `npm run eval:longmemeval` | **NEEDS CREDITS** | Judged LongMemEval Tier-A gate. Env: `LONGMEMEVAL_QUESTIONS`, `LONGMEMEVAL_LAMBDAS`, `LONGMEMEVAL_DECAY_HORIZON_FRAC`, `LONGMEMEVAL_REPEATS` (R averaged samples/context; default 1, cost scales ×R). |
| `npm run eval:tierb` | **NEEDS CREDITS** | Judged dev-set (Tier-B) accuracy gate. |

Both Tier-A judged runners use `EVAL_ANTHROPIC_API_KEY` (or
`ANTHROPIC_API_KEY`) for the documented Claude gate. For an exploratory local
run, set `EVAL_LOCAL_BASE_URL=http://127.0.0.1:1234/v1` and
`EVAL_LOCAL_MODEL=local/<model>`. The endpoint must be literal loopback. The
runner prints the model and labels the result exploratory. Missing provider or
dataset exits nonzero. All judged runs are sampled, print an upper-bound
model-call count, and never fabricate a score.
The default `npm run test:eval` runs Tier-C, then Tier-B, then the full Tier-A
LoCoMo and LongMemEval runs (`evals/harness/runner.ts:183-190`). It stays
nonzero while Tier-C fails (29/50 at the defaults) or no judged provider is
configured. Flags other than `--fast` are rejected rather than ignored.

A bounded local Qwen LoCoMo comparison (one published question, one judge
sample) found the default per-hour λ=0.97 dropped all gold evidence (39/419
turns retained, exit 1). The predeclared span-based λ=0.5 setting retained
all gold evidence (320/419 turns, exit 0). Both judge scores were 1.0 for
full and pruned context, so this sample alone says little about answer quality.
The first LongMemEval haystack was about 491,000 characters; its local Qwen
completion timed out after 180 seconds without a score. Full benchmark
coverage and the Claude judged release gate remain open.

### Tier-A datasets (fetched on demand; gitignored — see ADR-0014)

```bash
# LoCoMo (CC BY-NC 4.0 — NonCommercial; do NOT redistribute):
git clone --depth 1 https://github.com/snap-research/locomo .tmp/locomo
mkdir -p evals/datasets/locomo && cp .tmp/locomo/data/locomo10.json evals/datasets/locomo/

# LongMemEval (MIT) — from Hugging Face:
mkdir -p evals/datasets/longmemeval
curl -sL -o evals/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
curl -sL -o evals/datasets/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
```

---

## Audit commands (v0.6.x)

The audit engine stops memory from becoming a hallucination amplifier: a
stored-then-injected FALSE fact makes the AI worse. Tier-1 is the **$0,
deterministic** gate — cross-reference a code-related fact against the repo's
real commit history (ADR-0017). Tier-2 (Llama spot-check) / Tier-3 (Opus) escalate
UNVERIFIED facts and are LLM-gated.

| Command | Cost | What it does |
|---|---|---|
| `npm run audit:repo [-- --max-count N]` | **FREE** | Index a repo's real git history into structured code changes and report them (commits / files / added·deleted·modified). No LLM. |
| `npm run audit:repo -- --facts <json>` | **FREE** | Attest a project-local JSON array of facts against that history: CONFIRMED (with commit evidence) / UNVERIFIED (→ Tier-2, gated) / CONFLICT (stale memory). Paths outside this project, symlinks, and secret-like paths are rejected. A CONFLICT yields a non-zero exit. |
| `npm run audit:repo -- --facts <json> --persist --org-id <uuid> --session-id <uuid>` | **FREE** | Record every Tier-1 outcome in `audit_statuses`; CONFLICTs also suppress their facts and enter `audit_conflicts` atomically. Needs Supabase creds and the status migration; skips cleanly without creds. |
| `npm run audit:conflicts [-- --org-id <uuid>] [--all]` | **FREE** | The spec's **alert** half ("CONFLICT ⇒ suppress + alert"): list the unacknowledged Historical-Drift queue from `audit_conflicts` (the table's `WHERE acknowledged = FALSE` partial index). `--all` includes acknowledged. Skips cleanly without Supabase creds. |
| `npm run audit:conflicts -- --ack <id> [--by <dev-uuid>]` | **FREE** | Acknowledge a conflict (clears it from the alert queue); org-scoped with `--org-id`. Verified end-to-end live (seed → list → ack → re-read). |

Tier-1 is FREE and runs end-to-end today; escalating the UNVERIFIED residue to the
Tier-2 Llama / Tier-3 Opus models (and wiring the audit as a request-path injection
gate) is **NEEDS CREDITS** and follows the same Tier-A validation discipline as the
pruner (no suppression in the request path until validated). See ADR-0017.

---

## Current ship status (v0.4.x)

The judged gate at the documented λ=0.97 is **RED** (it decays weeks-old evidence to
~2% survival). Scale-invariant decay (ADR-0015, `*_DECAY_HORIZON_FRAC`) recovers
~93% evidence survival on both LoCoMo + LongMemEval (FREE survival sweeps) and is
wired default-OFF into the shadow `ContextManager`. The judged ship-decision run on
the calibrated config (NEEDS CREDITS) is the remaining gate before pruning can move
from shadow into the request path. See ADR-0014/0015/0016 + `docs/EVAL_FRAMEWORK.md`.
