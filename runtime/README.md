# DevOps runtime: proxy, memory and pruner

> **Eliminate AI Slop. Kill the Context Tax. Build Deterministic Intelligence.**

The DevOps proxy is a high-fidelity middleware proxy that sits between your AI agent (Claude Code, AutoGPT, custom agents) and the LLM API. It prunes irrelevant context using the CQ-Extended KadaneDial algorithm and stores memory in a three-tier architecture. It runs on your own machine, is open source (MIT), and charges nothing.

This directory is the local runtime of DevOps, one platform with the workflow at the repository root (`docs/decisions/0026-one-platform-named-devops.md`). It was once a separate product called Stratum, or CQ. Older documents and the current settings (`CQ_*`) still use those names until the naming cycle in `../specs/ops/one-platform-naming.md` renames them; the old names will keep working for one release after that.

---

## The Problem

As of 2026, the "Long Context" arms race has failed the enterprise:

| Pain Point | Reality |
|---|---|
| **Context Tax** | ~80% of AI spend goes to noise — boilerplate, repetitive logs, stale history |
| **Memory Drift** | Summaries-of-summaries compound hallucinations over months of use |
| **Performance Slop** | 1M+ token windows push latency from <2s to >30s |
| **Compaction Degradation** | No Ground Truth anchor means the AI forgets what was actually decided |

---

## The Solution

The DevOps proxy acts as a **Semantic Surgeon** — a deterministic proxy that:

1. **Prunes** context using CQ-Extended KadaneDial (extending DyCP, arXiv:2601.07994)
2. **Stores** history as attested structured facts, not lossy summaries
3. **Verifies** AI memory against Git commit history in real time
4. **Measures** every call with exact token counts and shows token and USD estimates, for information only; there is no fee

---

## Status — what runs today

A working build, not a sketch. On the current branch:

- **Proxy** — a Fastify server (`npm run dev`) with token measurement + a waste dashboard (Phase 1, personal use), plus an opt-in **commercial mode** (`CQ_COMMERCIAL=true`) with multi-tenant API-key auth (hash-only) and org-scoped `/v1/{config,memory,billing,sessions}` APIs over Supabase.
- **Memory** — the three tiers are live on Supabase (hot RAM · warm fact tables · cold pgvector + knowledge graph, per ADR-0013); Pinecone/Neo4j remain swappable seams.
- **Pruner** — CQ-Extended KadaneDial + a local ONNX encoder, built + eval-harnessed, but **not yet in the request path** (it ships only after a published Tier-A eval passes <5% faithfulness degradation — constitution).
- **Audit** — deterministic Git-attestation (Tier-1) runs free (`npm run audit:repo`, `audit:conflicts`); the Llama/Opus tiers are gated on credits.
- **Billing** — the token-arbitrage engine (20% of savings), HMAC-signed append-only records, invoice + CFO dashboard + audit CSV (`npm run invoice` / `verify-billing`). The **Stripe send is implemented** (customer → invoice → finalize behind a seam, dollars→cents tested, a live key refused until verified — `npm run verify-stripe`), the **inbound `invoice.paid` webhook** records payment (`POST /stripe/webhook`, signature-verified), and in local commercial mode the **request path journals signed usage** in a private durable outbox before replaying it to `billing_records`. The local PostgreSQL schema and focused billing paths have been verified; public partner billing remains unverified. **Scheduled for removal:** the project is open source with no payment (ADR-0025, `docs/decisions/0025-open-source-local-first-no-payment.md`); graph cycles C1–C4 remove this layer and keep usage measurement (`../specs/ops/payment-removal.md`). Separately, and already done: the billing-path four-eyes approval gate (`hooks/universal/pre-tool/deploy-gate.sh`, requiring two human approval markers from distinct approvers on a commit or push touching this directory) was retired by owner decision on 2026-09-26 — that is a repository process control, distinct from the payment code itself, which C1–C4 above still have to remove.
- **Deploy + onboard** — DevOps runs locally through `npm run setup` and Docker Compose; there is no packaged image and no public URL (owner decision O-11, ADR-0025 — `docs/decisions/0025-open-source-local-first-no-payment.md`; `../specs/security/stratum-local-network.md` REQ-6). A command-level **`docs/COMMERCIAL_ONBOARDING.md`** runbook (`create-org` → `create-api-key` → integrate → invoice → `verify-stripe`) covers commercial-mode setup. Machine-readable contract at `GET /openapi.json`; browsable at `GET /docs`.

Full operator + API surface: [`docs/MEMORY_AND_EVAL_COMMANDS.md`](docs/MEMORY_AND_EVAL_COMMANDS.md); team-mode onboarding: [`docs/COMMERCIAL_ONBOARDING.md`](docs/COMMERCIAL_ONBOARDING.md). **Gated on external inputs:** Anthropic credits (judged eval ship-decision · audit Tier-2/3 · live ingestion). The ZK-Context (AWS Nitro TEE) plan and the paid-partner path were dropped on 2026-09-26 (ADR-0025).

---

## Quick Start

```bash
git clone https://github.com/MILTONADINA/DevOPs.git
cd DevOPs
npm run setup                 # requires Node >=22.12 and Docker Compose
cd runtime
# Configure a provider in your process environment or secret manager first.
npm run dev
```

Root setup starts the loopback-only local database and verifies proxy/database
startup. It does not install an LLM provider or leave the proxy running. For a
local OpenAI-compatible provider, set `CQ_LOCAL_BASE_URL` to its loopback API
before `npm run dev`.

Point Claude Code at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
```

Waste dashboard: `http://localhost:4080/dashboard`

**Commercial (multi-tenant) mode** — use the local Compose credential handoff
and configure a provider in the process environment:

```bash
CQ_COMMERCIAL=true npm run db:with-env -- npm run dev
npm run db:with-env -- npm run create-api-key -- --org-id <uuid> --name "my key"
# then: curl -H "Authorization: Bearer <key>" http://localhost:4080/v1/config
```

---

## Documentation Index

### Architecture & Design
| Document | Purpose |
|---|---|
| [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) | Full system architecture, data flow, invariants |
| [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md) | TypeScript interfaces, Postgres DDL, data models |
| [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md) | Three-tier memory system design |
| [`docs/ALGORITHM.md`](docs/ALGORITHM.md) | CQ-Extended KadaneDial formal specification |
| [`docs/SECURITY.md`](docs/SECURITY.md) | ZK-Context and TEE architecture |
| [`docs/AUDIT_ENGINE.md`](docs/AUDIT_ENGINE.md) | Git-attestation and escalating audit logic |

### Development
| Document | Purpose |
|---|---|
| [`docs/EVAL_FRAMEWORK.md`](docs/EVAL_FRAMEWORK.md) | Pruning accuracy measurement methodology |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phase-by-phase build plan with acceptance criteria |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | New developer setup guide |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Production deployment — Workers, Nitro, Supabase |
| [`docs/MONITORING.md`](docs/MONITORING.md) | Metrics, alerting, and incident runbooks |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines and PR checklist |
| [`.claude/CLAUDE.md`](.claude/CLAUDE.md) | Instructions for Claude Code agents |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history |

### Integration & API
| Document | Purpose |
|---|---|
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | All proxy endpoints and request/response shapes |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | How to wire CQ into Claude Code, LangChain, etc. |
| [`docs/WEBHOOKS.md`](docs/WEBHOOKS.md) | Webhook events, payloads, and signature verification |
| [`docs/RATE_LIMITS.md`](docs/RATE_LIMITS.md) | Rate limits, quotas, and backoff strategies |

### Positioning
| Document | Purpose |
|---|---|
| [`docs/COMPETITOR_ANALYSIS.md`](docs/COMPETITOR_ANALYSIS.md) | Mem0, Zep, Letta, LangMem side-by-side |
| [`docs/decisions/0025-open-source-local-first-no-payment.md`](docs/decisions/0025-open-source-local-first-no-payment.md) | Open source, local-first, no payment (owner decision 2026-09-26) |

### Reference
| Document | Purpose |
|---|---|
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Authoritative definition of all project terms |
| [`docs/FAQ.md`](docs/FAQ.md) | Common questions from users and developers |
| [`docs/enclave-pcr-values.md`](docs/enclave-pcr-values.md) | Historical: the planned TEE attestation PCR values. No enclave was built, and ADR-0025 dropped the TEE on 2026-09-26 |
| [`docs/paper-notes.md`](docs/paper-notes.md) | Notes on arXiv:2601.07994 (fill in after reading) |
| [`docs/waste-taxonomy.md`](docs/waste-taxonomy.md) | Phase 0 waste category template (fill in from data) |
| [`SECURITY_POLICY.md`](SECURITY_POLICY.md) | Vulnerability disclosure policy |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community standards (repository root; covers the whole platform) |

### Architecture Decision Records
| Document | Decision |
|---|---|
| [`docs/decisions/0001-supabase-over-sqlite.md`](docs/decisions/0001-supabase-over-sqlite.md) | Supabase (Postgres) over SQLite |
| [`docs/decisions/0002-time-based-decay.md`](docs/decisions/0002-time-based-decay.md) | Time-based (hours) over turn-count decay |
| [`docs/decisions/0003-hybrid-local-pruning-for-zk.md`](docs/decisions/0003-hybrid-local-pruning-for-zk.md) | Client-side pruning for ZK-Context |
| [`docs/decisions/0004-no-llm-summarization.md`](docs/decisions/0004-no-llm-summarization.md) | Structured facts over LLM summaries |
| [`docs/decisions/0005-cloudflare-workers.md`](docs/decisions/0005-cloudflare-workers.md) | Cloudflare Workers over traditional Node server |
| [`docs/decisions/0006-pinecone-plus-neo4j.md`](docs/decisions/0006-pinecone-plus-neo4j.md) | Dual cold storage: Pinecone + Neo4j |
| [`docs/decisions/0007-llama-for-extraction.md`](docs/decisions/0007-llama-for-extraction.md) | Llama 4-8B for fact extraction |
| [`docs/decisions/ADR_TEMPLATE.md`](docs/decisions/ADR_TEMPLATE.md) | Template for future ADRs |

---

## Architecture Overview

```
┌─────────────────────────────────┐
│   User Agent (Claude Code etc.) │
└────────────────┬────────────────┘
                 │ HTTP (Anthropic API shape)
                 ▼
┌─────────────────────────────────┐
│       DevOps Proxy (Edge)       │
│  Cloudflare Workers + D.O.      │
│  ─ Token measurement            │
│  ─ CQ-Extended KadaneDial       │
│  ─ ZK-Context decryption (TEE)  │
└────────┬────────────────────────┘
         │
   ┌─────▼──────────────────────┐
   │      Memory Tiers          │
   │  T1: Hot  (RAM, 2hr)       │
   │  T2: Warm (Supabase, 30d)  │
   │  T3: Cold (Pinecone+Neo4j) │
   └─────┬──────────────────────┘
         │
         ▼
   Anthropic / OpenAI API
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Proxy server | Fastify (Node) today; Cloudflare Workers + Durable Objects is the roadmap edge target |
| Language | TypeScript (proxy, memory, audit) · Rust (hot-path string ops) |
| Client pruner | ONNX Runtime (<10ms local inference) |
| Warm storage | Supabase (Postgres) |
| Cold storage | Supabase pgvector + a Postgres knowledge graph (ADR-0013; Pinecone/Neo4j are swappable seams) |
| Audit models | Llama 4-8B (spot-check) · Claude Opus (escalation) |
| Security | PII redaction · hash-only API keys · row-level security (the AWS Nitro TEE plan was dropped, ADR-0025) |

---

## Cost

The DevOps runtime is free and open source (MIT). The project charges no fee and bills
nobody; the invoice code still in the tree is scheduled for removal (see
Status above). The proxy shows token counts and USD estimates so you can see what your own
provider usage costs; you pay your LLM provider directly. See
[`docs/decisions/0025-open-source-local-first-no-payment.md`](docs/decisions/0025-open-source-local-first-no-payment.md).

---

## Research Foundation

> Choi, N. et al. *DYCP: Dynamic Context Pruning for Long-Form Dialogue with LLMs.* arXiv:2601.07994, January 2026.

CQ extends the base DyCP/KadaneDial algorithm with a temporal decay factor λ. See [`docs/ALGORITHM.md`](docs/ALGORITHM.md).

---

## License

MIT
