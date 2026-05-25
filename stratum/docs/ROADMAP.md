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
- [ ] At least one design partner (a developer or small agency) has used the proxy for a week
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
- [ ] Port or download the Tier A benchmark datasets (LoCoMo, MT-Bench+, SCM4LLMs)
- [ ] Create the Tier B developer workload scenarios (at least 4)
- [ ] Create the Tier C golden query set (at least 30 queries)
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
- [ ] Design partner confirms AI quality has not noticeably degraded

---

## Phase 3 — Three-Tier Memory Schemas (Months 3–4)

**Goal:** Persistent memory with structured fact extraction.

### Tasks

- [ ] Implement full Supabase schema for all fact tables (see `TECHNICAL_SPEC.md`)
- [ ] Implement Tier 1 memory (`src/memory/hot/`) — rolling window in Durable Object state
- [ ] Implement Tier 2 fact extraction (`src/memory/warm/extractor.ts`) using Llama 4-8B
  - Extractor must output Zod-validated structured facts only
  - Never store if schema validation fails
- [ ] Implement all five fact type schemas with Zod
- [ ] Implement Tier 3 Pinecone upsert (`src/memory/cold/pinecone.ts`)
- [ ] Implement Tier 3 Neo4j graph write (`src/memory/cold/neo4j.ts`)
- [ ] Implement the nightly promotion job (Tier 2 → Tier 3)
- [ ] Implement memory retrieval — when KadaneDial is insufficient, query Tier 2/3
- [ ] Write Tier B eval scenario: fact survives 50-turn gap and is correctly retrieved

### Acceptance Criteria

- [ ] A `FunctionChange` fact extracted in session A is retrievable in session B (same org)
- [ ] Tier 2 query latency < 50ms p95
- [ ] Tier 3 Pinecone query latency < 150ms p95
- [ ] Tier 3 Neo4j query returns correct function status in < 80ms
- [ ] Nightly promotion job completes without errors
- [ ] Fact extraction never writes to DB if Zod validation fails (test this explicitly)
- [ ] Schema: all fact tables have `is_verified`, `is_suppressed`, `commit_hash` columns

---

## Phase 4 — ZK-Context + TEE (Months 5–8)

**Goal:** Enterprise-grade encryption with hardware attestation.

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
- [ ] Cost monitoring: Opus audit costs logged and alerting if > 2% of revenue

### Acceptance Criteria

- [ ] Test: inject a `FunctionChange` fact that contradicts the Git history → CONFLICT detected
- [ ] Test: inject a correct `FunctionChange` fact → CONFIRMED
- [ ] Test: Llama spot-check correctly flags an incoherent fact with confidence < 0.85
- [ ] Opus escalation rate: < 1% of all facts in a test dataset of 1000 facts
- [ ] Historical Drift alert appears on dashboard within 5 seconds of CONFLICT detection
- [ ] Git index runs incrementally (< 5s for last 100 commits)

---

## Phase 6 — Token Arbitrage Billing (Month 10+)

**Goal:** A billing system that CFOs trust and can audit.

### Tasks

- [ ] Implement `BillingRecord` writes with HMAC-SHA256 signing
- [ ] Make billing table append-only (Postgres trigger prevents UPDATE/DELETE)
- [ ] Implement monthly invoice generation
- [ ] Build the CFO dashboard:
  - Monthly spend: original vs. quarantined
  - Savings by project, by developer
  - CQ fee calculation
  - Export to CSV/PDF
- [ ] Implement Stripe integration for payment
- [ ] Implement per-org pricing tiers (Starter, Growth, Enterprise)
- [ ] GDPR erasure endpoint that anonymizes billing records (keeps financial record, removes PII)

### Acceptance Criteria

- [ ] Billing records cannot be modified after writing (test: attempt UPDATE, expect failure)
- [ ] Invoice matches manual calculation of `0.20 × (original - quarantined) × price`
- [ ] GDPR erasure completes within 30 seconds for a 1-year history
- [ ] CFO dashboard: a non-technical person can understand the savings in < 2 minutes
- [ ] First real invoice sent and paid by a design partner

---

## Milestone Summary

| Milestone | Target | Deliverable |
|---|---|---|
| M0 | Week 2 | Waste taxonomy + paper notes |
| M1 | Week 6 | Working measurement proxy with design partner |
| M2 | Week 14 | Pruning proxy passing eval suite |
| M3 | Month 4 | Three-tier memory with fact extraction |
| M4 | Month 8 | ZK-Context with TEE attestation |
| M5 | Month 10 | Git-attestation audit engine live |
| M6 | Month 12 | Billing engine + first paying enterprise customer |
