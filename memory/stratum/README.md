# Stratum Memory Backend

DevOPs's wiring **spec** for a future Stratum integration. As of 2026-05-24,
Stratum is a **single-commit scaffold** — none of the capabilities described
here run yet. The env vars and config fields below are forward-looking; no
consumer code currently calls Stratum, because Stratum has no running
surface to call.

For the canonical inventory of what Stratum actually is today, see
[`.workflow/state/stratum-audit/01-stratum-state.md`](../../.workflow/state/stratum-audit/01-stratum-state.md).
Closes the README-vs-reality drift filed as **PB-11** in Session 7's audit.

---

## Scaffold reality (audit-derived)

| Metric | Value |
|---|---|
| Upstream repo | https://github.com/MILTONADINA/Stratum.git |
| Merged into DevOPs | `stratum-merge` branch at `stratum/` (subtree, no `--squash`) |
| Commits in upstream history | **1** (`89457997…`, 2026-04-06) |
| Tracked file count | 101 |
| Tracked content size | 0.3 MB |
| License | MIT (note: internal branding says "Startum"; minor upstream typo) |
| Tracked tests | **0** (three `.gitkeep` placeholders only) |
| Architecture docs | ~5,116 LOC across `stratum/docs/` |
| Substantive (non-stub) code | **~516 LOC** total: 248 SQL (Supabase schema) + 247 TS (Phase-0 capture script) + ~10 Rust (one `sha256_hex` fn) |
| TODO/FIXME markers in `stratum/src/` | 29 |
| Stratum-roadmap phases shipped | **0 of 7** |

> What you can actually do today with the merged `stratum/` tree:
> read architecture docs, inspect a 248-LOC unapplied Postgres migration,
> run `stratum/scripts/capture-session.ts` to intercept your own Claude Code
> sessions to JSON (needs `ANTHROPIC_API_KEY`), and build the Rust
> `sha256_hex` WASM helper. That is the complete capability surface.

---

## Scope locked: Option B (decided 2026-05-24)

Per the Session-7 audit's three-option tree
([`03-integration.md`](../../.workflow/state/stratum-audit/03-integration.md))
and Session-7.5 application
([`04-gap-roadmap-deltas.md`](../../.workflow/state/stratum-audit/04-gap-roadmap-deltas.md)),
**Option B is locked**:

- **To be built** under DevOPs Phase 3 (estimated **~619h total**):
  - Stratum **Phase 0** — Observation (session capture + waste taxonomy + DyCP paper notes)
  - Stratum **Phase 1** — Measurement Proxy (Cloudflare Worker / Fastify + exact token counting + dashboard + Supabase persistence)
  - Stratum **Phase 3** — Three-Tier Memory Schemas (Tier 1/2/3 storage + Llama fact extractor + Pinecone + Neo4j) — this is the integration surface DevOPs reads from
  - DevOPs ↔ Stratum integration wiring + operational deployment
- **Deferred to post-v0.3.0** (re-scope hook when Phase 0+1+3 production telemetry surfaces):
  - Stratum **Phase 2** — CQ-Extended KadaneDial Pruner
  - Stratum **Phase 4** — ZK-Context + AWS Nitro TEE
  - Stratum **Phase 5** — Git-Attestation Audit Engine
  - Stratum **Phase 6** — Token Arbitrage Billing

Decision rationale (per user, 2026-05-24): Option B preserves the trajectory
toward Option C without committing ~1,179h upfront. Option A
under-delivers — without Phase 3 integration, Stratum is just storage, and
pruning + DevOPs wiring is what makes context actually persistent across
agents.

---

## Stratum's own 7-phase taxonomy + state markers

These are **Stratum's** phases as defined in
[`stratum/docs/ROADMAP.md`](../../stratum/docs/ROADMAP.md). The state
markers reflect Option B (locked 2026-05-24).

| # | Stratum phase | Goal | State |
|---|---|---|---|
| 0 | **Observation** | Session capture + waste taxonomy + DyCP paper notes | ⬜ scaffold (capture script exists; 5 real-session corpus + taxonomy doc not committed) |
| 1 | **Measurement Proxy** | Cloudflare Worker / Fastify + exact token counting + Supabase persistence + dashboard | ⬜ scaffold (`stratum/src/proxy/worker.ts` returns `"not yet implemented"`) |
| 2 | **CQ-Extended KadaneDial Pruner** | ONNX bi-encoder + algorithm + eval suite | ⏸ **deferred post-v0.3.0** |
| 3 | **Three-Tier Memory Schemas** | Tier 1 (hot/Durable Objects) + Tier 2 (warm/Postgres + Llama extractor) + Tier 3 (cold/Pinecone + Neo4j) | ⬜ scaffold (`stratum/src/memory/warm/tier2.ts` is 10 LOC; no Tier 1/3 implementations) |
| 4 | **ZK-Context + TEE** | AES-256-GCM client-side encryption + AWS Nitro Enclave + attestation | ⏸ **deferred post-v0.3.0** |
| 5 | **Git-Attestation Audit Engine** | Git indexer + Llama spot-check + Opus escalation + `audit_conflicts` table | ⏸ **deferred post-v0.3.0** |
| 6 | **Token Arbitrage Billing** | HMAC-signed records + monthly invoice + Stripe integration + CFO dashboard | ⏸ **deferred post-v0.3.0** |

Legend:
- ⬜ — scaffold present, Option-B-targeted, not started
- ⏸ — deferred to post-v0.3.0, re-scope candidate

---

## Wiring spec (forward-looking; no consumer code wired today)

Once Stratum Phase 1 ships (the HTTP API surface DevOPs would call), the
env vars below activate the DevOPs `session-start` hook to call Stratum.
**Until then, these are documentation of the intended interface.**

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080   # Stratum proxy when Phase 1 ships
export STRATUM_API_KEY=<your-key>                 # api_keys table exists in schema; no issuer yet
export STRATUM_TENANT_ID=<client-id>              # organizations.id; per-client scoping (Phase 1+)
```

`config.yml` carries the wiring spec's tunables. Header in that file flags
each field as spec-not-operational. See
[`config.yml`](./config.yml).

---

## What Stratum's schema defines (for reference)

Stratum's Supabase migration ([`stratum/supabase/migrations/20260406000000_initial_schema.sql`](../../stratum/supabase/migrations/20260406000000_initial_schema.sql))
declares these tables. The schema is **tracked but not applied** to any
Supabase project:

- `organizations` / `developers` / `org_config` — tenancy + per-org tunables
- `sessions` — per-session metadata (session_id, tenant_id, started_at, ended_at, total_tokens, total_cost_usd)
- `billing_records` — append-only ledger (HMAC signing is **Phase 6**, not Phase 1)
- `audit_conflicts` — git-attestation conflict log (Phase 5; not Phase 1)
- `api_keys` — Stratum API key hash storage (Phase 1+)

Fact tables referenced in `stratum/docs/TECHNICAL_SPEC.md`
(`function_changes`, `tech_decisions`, `policy_updates`, `todos`,
`variable_changes`) are **NOT** in the committed migration — they are
Phase 3 work.

---

## How DevOPs will read Stratum (when Phase 1+3 ship)

Forward-looking design only. Today's `session-start` hook does not call
Stratum (no surface to call). When Phase 1+3 are operational, the hook
will:

- Retrieve top-N facts relevant to the current task (cosine similarity over Stratum Tier 3)
- Surface unresolved `audit_conflicts` for the project (Phase 5, deferred — placeholder in current schema)
- Inject last-N `tech_decisions` into session context (Phase 3 fact-extraction output)

Note: the `audit_conflicts` integration is Phase 5 work, which is **deferred
post-v0.3.0**. The README previously described this as Stratum's memory-
poisoning defense and DevOPs's reason for using Stratum; that defense
remains the long-term value proposition, but it ships **after** v0.2.0
(Option B locked).

---

## Status of prior README claims (audit reconciliation)

The previous README's Status table claimed several phases as "ready". The
audit reconciled each claim against Stratum's actual state:

| Prior claim | Audit verdict | Source |
|---|---|---|
| "Phase 0 capture proxy: ready" | **Misleading** — a 247-LOC capture script exists; not a running proxy; 5-session corpus + taxonomy not committed | [`01-stratum-state.md`](../../.workflow/state/stratum-audit/01-stratum-state.md) |
| "Phase 0 Supabase schema: ready" | **Partial** — 248 LOC SQL is authored but unapplied | [`02-overlap.md`](../../.workflow/state/stratum-audit/02-overlap.md) |
| "Phase 1 git attestation: ready" | **False (doubly)** — git-attestation is Stratum's Phase 5 (not Phase 1), and it is unbuilt | [`02-overlap.md`](../../.workflow/state/stratum-audit/02-overlap.md) |
| "DevOPs uses everything Stratum has ready today" | **False in practice** — no Stratum HTTP surface exists for the DevOPs hook to call | [`02-overlap.md`](../../.workflow/state/stratum-audit/02-overlap.md) |
| "Pruning is wired but pass-through until Phase 2 ships" | **Technically true, operationally false** — `pruning.enabled: false` in `config.yml`; no proxy exists to pass through | [`02-overlap.md`](../../.workflow/state/stratum-audit/02-overlap.md) |

This README is now the audit-reconciled version. The five claims above
have been **removed or rewritten** rather than preserved.

---

## Cross-references

- Authoritative scaffold inventory: [`.workflow/state/stratum-audit/01-stratum-state.md`](../../.workflow/state/stratum-audit/01-stratum-state.md)
- Overlap analysis (DevOPs claims vs reality): [`.workflow/state/stratum-audit/02-overlap.md`](../../.workflow/state/stratum-audit/02-overlap.md)
- Integration cost (Option A / B / C scopes): [`.workflow/state/stratum-audit/03-integration.md`](../../.workflow/state/stratum-audit/03-integration.md)
- ROADMAP / GAP_61 deltas (proposed + applied): [`.workflow/state/stratum-audit/04-gap-roadmap-deltas.md`](../../.workflow/state/stratum-audit/04-gap-roadmap-deltas.md)
- Refined launch readiness math: [`docs/LAUNCH_READINESS.md`](../../docs/LAUNCH_READINESS.md)
- Stratum's own roadmap: [`stratum/docs/ROADMAP.md`](../../stratum/docs/ROADMAP.md)
- Polish-backlog entry that triggered this revision: PB-11 (filed in [`.workflow/state/polish-backlog.md`](../../.workflow/state/polish-backlog.md), local-only)
