# ROADMAP.md — Phase-by-Phase Build Plan

## Guiding Rule

**Do not begin a phase until the previous phase's acceptance criteria are fully met and documented.** The phases are ordered by dependency and risk, not by excitement. Phase 0 and 1 feel slow — they are the most important.

---

## Phase 0 — Observation (Weeks 1–2)

**Goal:** Understand what real AI waste looks like before building anything to fix it.

### Tasks

- [ ] Write a session capture script (`scripts/capture-session.ts`) that:
  - Intercepts one Claude Code session
  - Dumps the raw Anthropic API request/response pairs to a timestamped JSON file
  - Counts exact tokens per request using `@anthropic-ai/sdk`
- [ ] Run the script on at least 5 real Claude Code sessions (your own, across different projects)
- [ ] Manually analyze the captured JSON and produce a `docs/waste-taxonomy.md` with:
  - Categories of waste observed (boilerplate, tool echoes, stale files, etc.)
  - Rough % of tokens per category
  - The single most frequent type of waste
- [ ] Read the full DyCP paper (arXiv:2601.07994), not just the abstract — focus on the benchmarks and failure cases

### Acceptance Criteria

- [ ] At least 5 real sessions captured as JSON in `data/sessions/`
- [ ] `docs/waste-taxonomy.md` exists with at least 4 named waste categories
- [ ] You can state the answer to: "What is the #1 type of token waste in Claude Code sessions?"
- [ ] You have read the DyCP paper and written at least 5 notes in `docs/paper-notes.md`

---

## Phase 1 — Measurement Proxy (Weeks 3–6)

**Goal:** A working proxy that counts tokens accurately and reports waste. Zero pruning.

### Tasks

- [ ] Scaffold the project structure (see `CONTRIBUTING.md` for full layout)
- [ ] Implement `src/proxy/index.ts` — a Fastify server that:
  - Accepts requests in Anthropic API format
  - Forwards them to the real Anthropic API
  - Returns the response unchanged
  - Logs request/response to Supabase
- [ ] Implement exact token counting using `@anthropic-ai/sdk` (not tiktoken)
- [ ] Implement waste detection heuristics based on Phase 0 findings:
  - Detect repetitive tool output blocks
  - Detect identical system prompt repetitions
  - Detect file content reinjected across turns
- [ ] Build the dashboard at `/dashboard`:
  - Total tokens sent today / this week / this month
  - Estimated waste % per session
  - Cost at Anthropic pricing
  - Potential savings (what 80% pruning would have cost)
- [ ] Write integration tests for the proxy forward path
- [ ] Set up Supabase local with the `sessions` and `billing_records` schemas

### Acceptance Criteria

- [ ] Proxy works end-to-end: `ANTHROPIC_BASE_URL=http://localhost:4080 claude` routes correctly
- [ ] Token counts match the Anthropic API's own reported counts (±0 — must be exact)
- [ ] Dashboard is accessible and shows real numbers from a live session
- [ ] The proxy has been used for a week of real work (this was "at least one design partner"; the design-partner program was dropped on 2026-09-26 with the payment layer, ADR-0025; the replacement criterion is proposed in the root `plan.md` §9 and not yet confirmed by the owner)
- [ ] You have at least 20 real sessions in the database
- [ ] Waste categories from Phase 0 taxonomy are detected and labeled in the dashboard

---

## Phase 2 — CQ-Extended KadaneDial Pruner (Weeks 7–14)

**Goal:** Pruning that provably maintains AI quality at reduced token count.

### Tasks

- [ ] Select and export the ONNX bi-encoder model (start with `all-MiniLM-L6-v2` INT8)
- [ ] Implement `src/pruner/encoder.ts` — ONNX inference wrapper
  - Benchmark: must run < 10ms p99 on MacBook M2
- [ ] Implement `src/pruner/kadanedial.ts` — the CQ-Extended algorithm per `docs/ALGORITHM.md`
  - Use time-based decay (hours), not turn-count decay
  - Handle all edge cases (empty history, single turn, σ=0)
- [ ] Implement `src/pruner/pruner.ts` — orchestrates encoder + KadaneDial
- [ ] Build the eval harness (`evals/harness/runner.ts`)
- [x] Add LoCoMo and LongMemEval Tier-A loaders and separate judged runners; full passing judged runs remain open
- [ ] Create the Tier B developer workload scenarios (at least 4)
- [x] Create the Tier C golden query set (50 synthetic critical cases); the
  default λ=0.97 run currently fails 21 cases, so the zero-failure gate below
  remains open.
- [ ] Run evals against full-context baseline — confirm thresholds are met
- [ ] Integrate pruner into the Phase 1 proxy (now it prunes before forwarding)
- [ ] Update the dashboard to show: original tokens, pruned tokens, delta, $ saved

### Acceptance Criteria

- [ ] ONNX encoder: < 10ms p99 on MacBook M2 (benchmark in `evals/benchmarks/`)
- [ ] Eval suite passes: Faithfulness > 0.90, Answer Relevancy > 0.88 on all Tier A datasets
- [ ] Eval suite passes on all Tier B scenarios
- [ ] Zero failures on Tier C critical golden queries
- [ ] Pruner correctly rejects empty history without crashing
- [ ] Pruner uses time-based decay (test: sessions spanning > 6 hours)
- [ ] A week of real use confirms AI quality has not noticeably degraded (this was "design partner confirms"; see the Phase 1 note)

---

## Phase 3 — Three-Tier Memory Schemas (Months 3–4)

**Goal:** Persistent memory with structured fact extraction.

**Status (2026-09-23):** Hot/warm memory, five typed fact schemas, Supabase
graph/pgvector cold stores, promotion code, and a 50-turn survival test exist.
ADR-0013 approves Supabase for Tier 3; Pinecone/Neo4j adapters are optional.
The DevOPs session-start bridge, nightly schedule, and <50ms p95 Tier-2
release measurement remain open. See root `plan.md` §4 for the current gate.

### Tasks

- [x] Implement five typed Supabase fact tables (`supabase/migrations/20260406000000_initial_schema.sql`)
- [x] Implement Tier 1 memory (`src/memory/hot/tier1.ts`) — two-hour in-process rolling window
- [x] Implement Tier 2 fact extraction (`src/memory/warm/extractor.ts`) behind an injected completion model
  - Extractor must output Zod-validated structured facts only
  - Never store if schema validation fails
- [x] Implement all five fact type schemas with Zod
- [x] Implement Tier 3 Supabase pgvector store (`src/memory/cold/vectors.ts`)
- [x] Implement Tier 3 Supabase graph store (`src/memory/cold/graph.ts`)
- [ ] Schedule the existing Tier 2 → Tier 3 promotion script nightly
- [ ] Implement memory retrieval — when KadaneDial is insufficient, query Tier 2/3
- [x] Test a simulated 50-turn gap with a fake model and database (`test/memory/manager.test.ts`)

### Acceptance Criteria

- [ ] A `FunctionChange` fact extracted in session A is retrievable in session B (same org)
- [ ] Tier 2 query latency < 50ms p95
- [ ] Supabase Tier-3 graph/vector release latency meets a binding target measured on the user's machine (target to be set; there is no deployment, ADR-0025)
- [ ] Nightly promotion job completes without errors
- [x] Invalid extracted facts are dropped before persistence (`test/memory/warm-pipeline.test.ts`)
- [x] All five typed fact tables have `is_verified`, `is_suppressed`, and `commit_hash` columns (`20260406000000_initial_schema.sql`)

---

## Phase 4 — ZK-Context + TEE (Months 5–8) — DROPPED

**Dropped by owner decision, 2026-09-26** (ADR-0025,
`docs/decisions/0025-open-source-local-first-no-payment.md`). The enclave
protected user context on a server the project would host. The project hosts
nothing: Stratum runs on the user's machine. The tasks below are kept as a
record and are not planned. The offline AES-256-GCM primitive (ADR-0022)
stays in the tree as code.

**Goal (withdrawn):** Enterprise-grade encryption with hardware attestation.

### Tasks

- [ ] Implement client-side AES-256-GCM encryption (`src/pruner/crypto.ts`)
  - Session key derivation via HKDF-SHA256
  - IV: 12 random bytes per payload
  - Auth tag: 16 bytes, verified before decryption
- [ ] Deploy AWS Nitro Enclave with the decryption application
- [ ] Implement attestation flow (client verifies PCR measurements)
- [ ] Publish expected PCR values for each enclave release
- [ ] Implement the TEE Gateway in the proxy
- [ ] Add `zk_enabled` config toggle per org
- [ ] Security review: verify raw plaintext never appears in any log
- [ ] Write the attestation test: a modified enclave (wrong PCRs) must be rejected

### Acceptance Criteria

- [ ] End-to-end test: session completes correctly with ZK-Context enabled
- [ ] Modified enclave test: attestation verification rejects wrong PCR values
- [ ] Log audit: grep for any plaintext session content in Cloudflare logs → zero results
- [ ] Supabase audit: raw context appears nowhere in any table
- [ ] Latency impact of TEE: < 15ms added to request path (benchmark required)
- [ ] An independent reviewer (not you) has read `docs/SECURITY.md` and confirmed the design is correct

---

## Phase 5 — Git-Attestation Audit Engine (Months 7–10)

**Goal:** Eliminate hallucinated code history from the memory system.

### Tasks

- [ ] Implement the Git indexer (`src/audit/git-indexer.ts`)
  - Connect to GitHub/GitLab via OAuth
  - Parse unified diff format to extract function changes
  - Write to Neo4j (`:Function`, `:Commit`, `:DEPRECATED_BY` etc.)
- [ ] Implement the attestation checker (`src/audit/git-attestation.ts`)
- [ ] Implement Llama spot-check (`src/audit/llama-check.ts`) — 10% sample
- [ ] Implement Opus escalation (`src/audit/opus-escalation.ts`) — confidence < 0.85
- [ ] Implement `CONFLICT` → developer alert pipeline
- [ ] Build the `audit_conflicts` table and alerts UI on the dashboard
- [ ] Cost monitoring: Opus audit costs logged and alerting if > 2% of usage (root `plan.md` §5b; there is no revenue, and the basis for the 2% is still open)

### Acceptance Criteria

- [ ] Test: inject a `FunctionChange` fact that contradicts the Git history → CONFLICT detected
- [ ] Test: inject a correct `FunctionChange` fact → CONFIRMED
- [ ] Test: Llama spot-check correctly flags an incoherent fact with confidence < 0.85
- [ ] Opus escalation rate: < 1% of all facts in a test dataset of 1000 facts
- [ ] Historical Drift alert appears on dashboard within 5 seconds of CONFLICT detection
- [ ] Git index runs incrementally (< 5s for last 100 commits)

---

## Phase 6 — Payment removal + self-hosted team features (replaces Token Arbitrage Billing)

**Redefined by owner decision, 2026-09-26** (ADR-0025). This phase was a
token-arbitrage billing system: HMAC-signed records, an append-only ledger,
monthly invoices, a CFO dashboard with the fee, Stripe and pricing tiers. The
project is now open source with no payment. Much of that billing layer was
built ahead and is still in the tree; graph cycles C1–C4 remove it. The
requirements are in `../../specs/ops/payment-removal.md`, and the root
`plan.md` §8 is the checklist.

History: before this redefinition, Phase 6 recorded one completed item: "Make
billing table append-only (local PostgreSQL trigger proof rejects UPDATE, UPSERT,
DELETE, and TRUNCATE inside a rolled-back transaction)". Cycle C2 removes that
enforcement, because the usage ledger no longer needs to be tamper-evident for
billing.

**Goal:** A team can self-host Stratum on its own machines, with usage
measured and nothing billed.

### Tasks

- [x] Remove the payment HTTP surface: the CFO page, invoice and Stripe
  routes, and the fee fields (C1; see `../../docs/handoff/README.md` for verification)
- [ ] Make the usage ledger unsigned: no HMAC, no fee column, no append-only
  enforcement (C2 locally verified with M1, unsigned replay and no-secret
  entry point; required CI and merge pending)
- [ ] Delete the payment modules and their tests (C3)
- [ ] Remove the invoice tables and the billing-retention erasure blocker (C4)
- [ ] Keep exact token counts, with token and USD estimates shown as
  information only
- [ ] Session erasure endpoint. After C2 unsigned usage rows retain
  organization/session foreign keys and the API retention blocker; C4 removes
  that financial boundary and treats usage as ordinary session-linked data. No compliant erasure
  timing proof exists.

### Acceptance Criteria

- [ ] Every requirement of `../../specs/ops/payment-removal.md` is met
- [ ] Organizations and API keys work in team mode on a local install
- [ ] Session erasure completes within 30 seconds for a 1-year history

---

## Milestone Summary

| Milestone | Target | Deliverable |
|---|---|---|
| M0 | Week 2 | Waste taxonomy + paper notes |
| M1 | Week 6 | Working measurement proxy in real use |
| M2 | Week 14 | Pruning proxy passing eval suite |
| M3 | Month 4 | Three-tier memory with fact extraction |
| M4 | Month 8 | Dropped 2026-09-26 (ADR-0025) |
| M5 | Month 10 | Git-attestation audit engine live |
| M6 | Month 12 | Payment layer removed; self-hosted team features |
