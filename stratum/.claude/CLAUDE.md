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
│   ├── proxy/                 ← Cloudflare Worker proxy core
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

Each phase has explicit acceptance criteria. Do not begin Phase N+1 until Phase N criteria are met and documented.

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
- **Never use `tiktoken` for Anthropic token counts.** Use `@anthropic-ai/tokenizer` or the SDK's built-in counting endpoint.
- Token counts must be exact. Estimates are not acceptable — the billing model depends on provable numbers.
- Log both input tokens and output tokens for every proxied request.

### Schema Design
- Run every schema change through Supabase migrations. Never alter tables directly.
- All Tier 2 structured fact tables must have: `id uuid`, `created_at timestamptz`, `session_id uuid`, `commit_hash text nullable`, `confidence_score float`.
- Neo4j node types: `Function`, `Commit`, `Decision`, `Developer`, `Policy`. Edge types: `DEPRECATED_BY`, `REFERENCED_IN`, `SUPERCEDES`, `AUTHORED_BY`, `APPLIES_TO`.

### Algorithm Implementation
- Read `docs/ALGORITHM.md` fully before implementing KadaneDial.
- The temporal decay exponent must be time-based, not turn-count-based: `λ^(elapsed_seconds / 3600)`.
- The relevance score formula is: `R_i = (S_i - g) * λ^((now - timestamp_i) / 3600)` where `S_i` is the z-score normalized cosine similarity.
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
- Every exported function needs a JSDoc comment with `@param`, `@returns`, and `@throws`.
- Rust: use `thiserror` for error types. No `.unwrap()` in production paths.
- File names: `kebab-case.ts`. Class names: `PascalCase`. Functions and variables: `camelCase`. Constants: `SCREAMING_SNAKE_CASE`.

---

## Environment Variables

All secrets must be in `.env` (gitignored). Never hardcode keys. Required vars:

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
PINECONE_API_KEY=
PINECONE_INDEX=
NEO4J_URI=
NEO4J_USERNAME=
NEO4J_PASSWORD=
AWS_NITRO_ENCLAVE_CID=
AUDIT_MODEL_ENDPOINT=
OPUS_API_KEY=
CQ_MASTER_ENCRYPTION_KEY=
```

---

## Testing

```bash
npm run test          # unit tests
npm run test:eval     # pruning accuracy evals (slow, run before PRs)
npm run test:e2e      # end-to-end proxy flow
npm run lint          # eslint + prettier check
```

All tests must pass before any commit to `main`.

---

## Common Tasks

### Add a new Tier 2 structured fact type
1. Define the TypeScript interface in `src/types/facts.ts`
2. Write the Supabase migration in `supabase/migrations/`
3. Add the extractor function in `src/memory/warm/extractors/`
4. Write unit tests covering at least: happy path, null commit hash, confidence below threshold
5. Update `docs/TECHNICAL_SPEC.md` with the new schema

### Implement a new pruning heuristic
1. Read `docs/ALGORITHM.md` and `docs/EVAL_FRAMEWORK.md` first
2. Add the heuristic in `src/pruner/heuristics/`
3. Add it to the eval suite in `evals/heuristics/`
4. Run `npm run test:eval` and verify <5% degradation
5. Log the heuristic name in every pruning decision record

### Add a new API endpoint
1. Define request/response types in `src/types/api.ts`
2. Implement the handler in `src/proxy/routes/`
3. Update `docs/API_REFERENCE.md`
4. Write integration tests in `tests/api/`

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
