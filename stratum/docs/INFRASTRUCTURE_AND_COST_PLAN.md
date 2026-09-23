# Stratum — Infrastructure, Remaining Work & Cost Plan

**Prepared:** 2026‑05‑30 · **Owner/operator:** Milton Adina · **Stack constraint:** Vercel + Supabase only
**Prices verified against** vercel.com/pricing and supabase.com/pricing on 2026‑05‑30.

---

## TL;DR

The platform is **built, live, and hardened**. To *finish* it and run it commercially you need exactly **two paid plans — Vercel Pro and Supabase Pro — for a flat ~$45/month**, plus a free Stripe account and a **one‑time ~$20–50** of LLM credits to switch the savings engine on. Nothing else is required. Your ongoing per‑token LLM cost can be **$0** because each customer brings (or is billed for) their own model usage.

> **Bottom line: ~$45/month recurring + ~$50 once.** That is the entire cost of running this masterpiece.

---

## 1. Where the platform stands today (already done)

A commercial, multi‑tenant LLM **gateway + optimization** platform, deployed to your Vercel project and backed by your Supabase database:

- **Multi‑tenant API‑key auth**, per‑plan rate limits, token budgets, concurrent‑session caps.
- **Live deployment** on Vercel (`/health` 200, reaching real Supabase).
- **Multi‑provider routing** — one Anthropic‑compatible endpoint that runs on **Anthropic, OpenAI, OpenRouter, Gemini, or a local model**, billing the exact upstream token counts.
- **Billing pipeline** end‑to‑end: usage → signed `billing_records` → invoice engine → Stripe send → paid‑webhook → read API + CFO dashboard.
- **Security**: RLS on all 17 tables, append‑only financial ledger, service‑role‑only access, PII redaction, and **8 independent adversarial reviews + a full audit/bughunt/pentest** (≈75 confirmed defects fixed, incl. CRITICAL auth‑bypass, key‑leak, and double‑charge bugs). Live pentest confirms the public anon key reads **zero rows**.
- **Test suite: 825 passing**, typecheck + lint green.

What it does **not** yet do in production: actually *prune* tokens (the "20% of savings" value‑prop) — that is intentionally gated behind a safety eval (see §2B), and it needs the two paid plans to be commercial‑legal and always‑on.

---

## 2. What remains (and what each piece needs)

### A. Go‑commercial activation — *needs the two paid plans + a free Stripe account*

| Step | What it is | Needs |
|---|---|---|
| Upgrade Vercel → **Pro** | Hobby forbids commercial use and caps function duration; Pro unlocks commercial use, long streaming functions (the proxy streams long agentic responses), the encrypted env store, and production. | **Vercel Pro** ($20/mo) |
| Upgrade Supabase → **Pro** | The Free project **pauses after 7 days of inactivity** (which would take your live database offline) and has no backups. Pro never pauses, adds 7‑day daily backups, 8 GB, and more connections. | **Supabase Pro** ($25/mo) |
| Stripe account | Create a free Stripe account → get an `sk_test_` key → run `npm run verify-stripe` (a $1 test invoice round‑trip) → flip to `sk_live_` + register the `…/stripe/webhook` endpoint (`whsec_`). | **Stripe** (free; 2.9% + 30¢ per charge) |
| First paying customer | A design partner who routes their traffic through the proxy and pays the first invoice. | (a customer, not a cost) |

### B. Turn on the savings engine ("20% of savings") — *needs one‑time LLM credits*

Pruning is the actual business. It is held behind a **safety gate** (the constitution rule: pruning may not enter the request path until a published eval shows **<5% answer‑quality degradation**). To clear it you run the eval suite once with a real judge model; the local ONNX encoder is free, so the only cost is the judge/answerer API calls.

- **Needs:** a one‑time **~$20–50** of Anthropic (or other judge‑model) API credits.
- **Then:** enable pruning in the request path → every customer's bill drops → you invoice 20% of the measured drop.
- **No new infrastructure** — it runs on the same Vercel + Supabase.

### C. Optional enhancements — *no new infrastructure; build when you want*

These are already built on Supabase and need only wiring, not new services: the **three‑tier memory** (Supabase `pgvector` — **no Pinecone/Neo4j needed**) and the **git‑attestation audit engine** (deterministic tier is free; its optional LLM escalation is credit‑gated). Defer until a customer asks.

### D. The one thing Vercel can't host — *deferred by design*

The **TEE / ZK‑Context encryption** feature (encrypt customer context inside a hardware enclave) requires **AWS Nitro Enclaves** — specialized hardware that **does not exist on Vercel**. It is a premium, enterprise‑only add‑on and is **not needed for the masterpiece MVP**: your data is already protected by RLS, service‑role‑only access, PII redaction, and the fact that **no raw context is ever stored**. Revisit only if an enterprise contract requires hardware‑attested encryption, on a dedicated TEE host at that time.

---

## 3. What you need *from Vercel*

| | |
|---|---|
| **Plan** | **Pro — $20 / month** (per member; you're the only member). |
| **Why** | Commercial use is **not allowed on Hobby**; Pro is required. It also unlocks the long function durations the streaming proxy needs and the production env store you already use. |
| **What to do** | In the Vercel dashboard → upgrade the team to **Pro**. Your project is already deployed and the env vars are set — nothing else changes. |
| **Usage on top** | Active CPU $0.128/hr, memory $0.0106/GB‑hr, invocations $0.60/1M, data transfer 1 TB included then $0.15/GB. **At pilot traffic this is roughly $0–10/month**; it only grows with real customer volume (which is revenue‑generating). |

## 4. What you need *from Supabase*

| | |
|---|---|
| **Plan** | **Pro — $25 / month** (includes $10/mo of compute credits that cover the default Micro instance). |
| **Why** | The Free project **pauses after a week** and has no backups — unacceptable for a live commercial DB. Pro = **never pauses**, **8 GB** database, **7‑day daily backups**, more connections. |
| **What to do** | In the Supabase dashboard → upgrade the **organization** to **Pro**. Your schema/migrations are already applied and verified — nothing else changes. |
| **Do NOT buy yet** | **Point‑in‑Time Recovery (+$100/mo)** — the included 7‑day daily backups are sufficient for the MVP. Add PITR later, once revenue justifies it. |
| **Usage on top** | 250 GB egress included then $0.09/GB; 8 GB DB included then $0.125/GB. **At pilot scale this stays inside the included amounts (~$0).** |

---

## 5. Cost summary

### Recurring (monthly)

| Item | Provider | Base | Likely usage at pilot | Notes |
|---|---|---:|---:|---|
| **Pro plan** | **Vercel** | **$20.00** | $0–10 | required for commercial use + long streams |
| **Pro plan** | **Supabase** | **$25.00** | ~$0 | never‑pause + 7‑day backups; $10 compute credit included |
| Payments | Stripe | $0.00 | per‑charge | 2.9% + 30¢ per successful charge only |
| LLM tokens (production) | upstream API | **$0.00 to you** | — | each customer brings/pays for their own key (pass‑through); or you fund + bill it back |
| **Recurring total** | | **$45.00/mo** | **≈ $45–65/mo** | flat at the start |

### One‑time

| Item | Provider | Cost | Notes |
|---|---|---:|---|
| Safety eval to enable pruning | Anthropic API | **~$20–50 once** | the only LLM spend you must fund yourself |
| **One‑time total** | | **~$20–50** | |

### Optional / later (do **not** buy now)

| Item | Provider | Cost | When |
|---|---|---:|---|
| Point‑in‑Time Recovery | Supabase | +$100/mo | when revenue justifies tighter RPO |
| TEE encryption host | AWS Nitro (not Vercel) | varies | only for an enterprise contract requiring hardware attestation |

> **Total to finish and run the masterpiece: ~$45/month + a one‑time ~$50.**

---

## 6. How we keep the spend lowest (without cutting corners)

1. **Customers fund their own model usage.** The proxy forwards on the **customer's own LLM key** (or bills their usage back), so your ongoing per‑token cost is **$0** — you only ever invoice *20% of the savings* you create. This is the single biggest cost lever and it's already designed in.
2. **One judge run, not a subscription.** The pruning eval is a **one‑time** credit spend, not recurring. The encoder runs locally for free.
3. **Stay inside the included allowances.** Pilot traffic fits inside Vercel's 1 TB transfer and Supabase's 250 GB egress / 8 GB DB — so the only fixed cost is the two $20/$25 base plans.
4. **No fourth vendor.** Memory uses Supabase `pgvector` (not Pinecone), the graph uses Supabase tables (not Neo4j), and there is no separate queue/cache service — everything runs on the two plans you already chose.
5. **Skip PITR and TEE until they pay for themselves.** Both are real features, but neither is needed to ship or to be secure; adding them early is the only way this budget balloons.

---

## 7. Your activation checklist (in order)

- [ ] **Upgrade Vercel → Pro** (team settings → Plans).
- [ ] **Upgrade Supabase → Pro** (organization settings → Billing).
- [ ] Create a **Stripe** account → copy the **`sk_test_`** key.
- [ ] Run `npm run verify-stripe` (sends a $1 test invoice end‑to‑end). When it passes, switch to **`sk_live_`** and register the **`/stripe/webhook`** endpoint to get **`whsec_`**.
- [ ] Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (and, if self‑funding the proxy, an upstream LLM key) to **Vercel's env store** → redeploy.
- [ ] **Onboard the first partner**: `npm run create-org` → give them their CQ key → point their tool's `ANTHROPIC_BASE_URL` at your proxy.
- [ ] **(When ready to monetize savings)** fund the one‑time eval, run it green, enable pruning, then `npm run invoice -- --org-id <them> --send`.

---

*This document reflects the platform at commit `0dde17e` on branch `stratum-phase-0-capture`: v1.0.0 commercial foundation green except the two operator‑provided items (a Stripe key and a paying partner), multi‑provider gateway shipped and adversarially reviewed, 825 tests passing, deployed and verified live.*
