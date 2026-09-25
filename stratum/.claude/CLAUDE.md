# CLAUDE.md — Instructions for Claude Code Agents

This file tells Claude Code how to work inside the Startum (CQ) codebase. Read this entire file before touching any code.

---

## Project Summary

Startum is a TypeScript/Rust middleware proxy that intercepts LLM API calls, prunes irrelevant context using the CQ-Extended KadaneDial algorithm, and stores memory in a three-tier architecture (Hot/Warm/Cold). The business model charges 20% of token savings.

**You are building infrastructure, not a plugin.** Every decision has production implications. Do not take shortcuts on schema design, token counting accuracy, or eval coverage.

---

## Repository Layout

```
startum/
├── .claude/
│   └── CLAUDE.md              ← you are here
├── docs/
│   ├── BLUEPRINT.md           ← read this first for architecture
│   ├── TECHNICAL_SPEC.md      ← data models, schemas, API shapes
│   ├── MEMORY_ARCHITECTURE.md ← tier 1/2/3 design
│   ├── ALGORITHM.md           ← KadaneDial implementation spec
│   ├── SECURITY.md            ← ZK-Context and TEE
│   ├── AUDIT_ENGINE.md        ← Git-attestation logic
│   ├── EVAL_FRAMEWORK.md      ← how to test pruning accuracy
│   ├── API_REFERENCE.md       ← proxy endpoint contracts
│   ├── BUSINESS_MODEL.md      ← billing logic
│   └── ROADMAP.md             ← phase gates and acceptance criteria
├── src/
│   ├── proxy/                 ← proxy core: Fastify server (index.ts); Cloudflare Worker adapter (worker.ts) is the unverified edge target
│   ├── pruner/                ← KadaneDial + ONNX client
│   ├── memory/                ← tier 1/2/3 storage adapters
│   ├── audit/                 ← Git-attestation + model audit
│   ├── billing/               ← token delta calculation + invoicing
│   ├── dashboard/             ← waste reporting UI
│   └── types/                 ← shared TypeScript interfaces
├── rust/                      ← Rust crates for hot-path ops
├── evals/                     ← eval datasets and harness
├── scripts/                   ← capture, migration, tooling
└── tests/
```

---

## Current Build Phase

**Check `docs/ROADMAP.md` for the active phase before writing any code.**

Each phase has explicit acceptance criteria. Phases have overlapped in practice: v0.5.x and v0.6.x work landed before v0.4.x's gate passed. What may ship is governed by the release gates ("Ship gate") in the root `plan.md`, not by phase order. Do not mark a phase complete until its criteria are met and documented.

| Phase | Description |
|---|---|
| 0 | Session capture and token forensics — observation only |
| 1 | Measurement proxy — count tokens, log waste, no pruning |
| 2 | Client-side KadaneDial pruner with ONNX |
| 3 | Three-tier memory schemas and adapters |
| 4 | ZK-Context + AWS Nitro TEE integration |
| 5 | Git-attestation audit engine |
| 6 | Token arbitrage billing and CFO dashboard |

---

## Critical Rules

### Token Counting
- **Never use `tiktoken` for Anthropic token counts.** Count with the SDK's `countTokens` endpoint (`src/proxy/token-count.ts`); `@anthropic-ai/tokenizer` is unpublished, so do not add it.
- Billing depends on provable numbers. The exact counts are the response's `usage` (the billing basis) and the `countTokens` endpoint. When `countTokens` fails, the pre-flight count falls back to a chars/4 estimate flagged `token_count_method: "estimated"`, which billing must treat as non-provable. Never report an estimate as exact.
- Log both input tokens and output tokens for every proxied request.

### Schema Design
- Run every schema change through Supabase migrations. Never alter tables directly.
- Every Tier 2 structured fact table carries the shared warm-fact columns (`id`, `created_at`, `session_id`, `org_id`, `developer_id`, nullable `commit_hash`, `confidence` in 0..1, `is_verified`, `is_suppressed`, `promoted_to_t3`, `project_scope`, `source_exchange_id`), row-level security so only `service_role` reads or writes it, and the project-scope and exchange triggers. Copy them from the newest fact-table migration (`supabase/migrations/20260924230000_operational_references.sql`) and register the table in `FACT_TABLES` (`src/memory/warm/tier2.ts`); a fact table without `org_id` breaks tenant isolation.
- Tier 3 runs on Supabase behind the `KnowledgeGraph` and `VectorStore` interfaces (`src/memory/cold/graph.ts`, `src/memory/cold/vectors.ts`; ADR-0013). `graph.ts` defines the node kinds, the edge types and each edge's direction; the supersession edge is `SUPERSEDES`. `neo4j.ts` and `pinecone.ts` are stubs for a future adapter.

### Algorithm Implementation
- Read `docs/ALGORITHM.md` fully before implementing KadaneDial.
- The temporal decay exponent must be time-based, not turn-count-based: `λ^(elapsed_seconds / 3600)`.
- Decay the raw cosine similarity first, then normalize: `R_i = S_raw_i × λ^((now - timestamp_i) / 3600)`, `S = z-score(R)`; then select spans on the gains `S_i - g`, keeping a span whose cumulative gain reaches `θ`. Decay never applies to z-scored values (`docs/ALGORITHM.md` → The CQ-Extended Score; `src/pruner/kadanedial.ts`).
- Every pruning decision must be logged with: which turns were pruned, their relevance scores, and the gain threshold used.

### Security
- Never log decrypted context outside a TEE boundary.
- Client-side encryption must be AES-256-GCM with a per-session key derived from the user's master key using HKDF.
- The TEE attestation document must be verified before any decryption occurs. See `docs/SECURITY.md`.

### Eval Before Ship
- Every change to pruning logic requires running the eval suite in `evals/` before committing.
- Acceptable accuracy degradation from pruning: <5% on Faithfulness score (DeepEval), <5% on Answer Relevancy.
- If scores diverge by more than 5%, the similarity threshold is too aggressive. Do not ship.

---

## Code Style

- TypeScript strict mode always. No `any` types.
- All async functions must have explicit error handling. No unhandled promise rejections.
- Give each exported function a JSDoc comment that says what it does; add `@param`, `@returns` or `@throws` where the signature does not already make a parameter, the result or a thrown error clear.
- Rust: use `thiserror` for error types. No `.unwrap()` in production paths.
- File names: `kebab-case.ts`. Class names: `PascalCase`. Functions and variables: `camelCase`. Constants: `SCREAMING_SNAKE_CASE`.

---

## Environment Variables

All secrets must be in `.env` (gitignored). Never hardcode keys. `.env.example` is the starting template, but it does not match the code in either direction. The proxy's own configuration is gathered in `start()` in `src/proxy/index.ts` (among them `CQ_COMMERCIAL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `CQ_BILLING_SIGNING_SECRET`); `ANTHROPIC_API_KEY` is read by `src/lib/anthropic.ts`, the other provider keys in `src/proxy/providers/router.ts` and `src/proxy/default-deps.ts`, and the eval harness prefers `EVAL_ANTHROPIC_API_KEY` so eval spend stays off the proxy's key. No code reads the Pinecone, Neo4j, AWS Nitro, `AUDIT_MODEL_*`, `OPUS_API_KEY` or `CQ_MASTER_ENCRYPTION_KEY` entries (Tier 3 runs on Supabase per ADR-0013; the ADR-0022 encryption primitive is not wired), so a missing value there blocks nothing.

---

## Testing

```bash
npm run test          # vitest; collects only test/**/*.test.ts
npm run test:eval     # pruning accuracy evals (slow, run before PRs)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint + prettier check
npm run test:all      # typecheck + lint + test + test:eval
```

All tests must pass before any commit to `main`.

---

## Common Tasks

### Add a new Tier 2 structured fact type
1. Define the TypeScript interface in `src/types/facts.ts`
2. Write the Supabase migration in `supabase/migrations/`
3. Extend the extraction prompt and parsing in `src/memory/warm/extractor.ts` and the Zod schema in `src/memory/warm/schemas.ts`; the prompt's enum values, the Zod schema and the migration's CHECK constraints must match
4. Write unit tests under `test/memory/` covering at least: happy path, null commit hash, confidence below threshold
5. Update `docs/TECHNICAL_SPEC.md` with the new schema

### Implement a new pruning heuristic
1. Read `docs/ALGORITHM.md` and `docs/EVAL_FRAMEWORK.md` first
2. Add the heuristic in `src/pruner/` with unit tests under `test/pruner/`
3. Add it to the eval harness in `evals/harness/` (datasets in `evals/datasets/`)
4. Run `npm run test:eval` and verify <5% degradation
5. Log the heuristic name in every pruning decision record

### Add a new API endpoint
1. Define request/response types in `src/types/proxy.ts`
2. Implement the handler in `src/proxy/routes/`
3. Update `docs/API_REFERENCE.md` and `src/proxy/openapi.ts`
4. Write tests under `test/proxy/` or `test/integration/` (vitest collects only `test/**/*.test.ts`)

---

## What Not to Do

- Do not use SQLite anywhere. Supabase local (Postgres) for development.
- Do not summarize context using an LLM. Extract structured facts only. Summarization = lossy = the problem we are solving.
- Do not skip the eval suite because "it looks right." The eval suite is the definition of correct.
- Do not store raw unencrypted context in Supabase or Pinecone. Encrypted only.
- Do not use turn-count decay. Use time-based decay. Sessions span days.
- Do not implement the Opus audit as a default — it is an escalation path only, triggered when Llama confidence < 0.85.

---

## Architecture Decision Log

All architecture decisions must be recorded in `docs/decisions/` as ADR (Architecture Decision Record) files named `NNNN-short-title.md`. Template:

```markdown
# ADR-NNNN: Title

## Status
Proposed | Accepted | Deprecated

## Context
What problem are we solving?

## Decision
What did we decide?

## Consequences
What are the tradeoffs?
```

Do not make a significant design change without an ADR.
