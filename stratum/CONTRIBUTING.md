# CONTRIBUTING.md

## Before You Write Any Code

1. Read `docs/BLUEPRINT.md` — the architecture principles
2. Read `docs/ROADMAP.md` — check which phase is active
3. Read `.claude/CLAUDE.md` — the rules for this codebase
4. Check `docs/decisions/` for any ADRs relevant to what you're building

If you're using Claude Code, it has already read `CLAUDE.md` and knows the rules. Hold it to them.

---

## Project Structure

```
startum/
├── .claude/
│   └── CLAUDE.md                  ← Claude Code instructions
├── docs/
│   ├── BLUEPRINT.md
│   ├── TECHNICAL_SPEC.md
│   ├── MEMORY_ARCHITECTURE.md
│   ├── ALGORITHM.md
│   ├── SECURITY.md
│   ├── AUDIT_ENGINE.md
│   ├── EVAL_FRAMEWORK.md
│   ├── API_REFERENCE.md
│   ├── BUSINESS_MODEL.md
│   ├── ROADMAP.md
│   ├── decisions/                 ← Architecture Decision Records (ADRs)
│   │   └── 0001-supabase-over-sqlite.md
│   └── paper-notes.md             ← Notes on arXiv:2601.07994
├── src/
│   ├── proxy/
│   │   ├── index.ts               ← Fastify server
│   │   ├── routes/
│   │   │   ├── messages.ts        ← POST /v1/messages
│   │   │   ├── sessions.ts        ← GET /v1/sessions
│   │   │   └── billing.ts         ← GET /v1/billing
│   │   └── tee/
│   │       ├── gateway.ts         ← TEE routing
│   │       └── attestation.ts     ← PCR verification
│   ├── pruner/
│   │   ├── encoder.ts             ← ONNX bi-encoder wrapper
│   │   ├── kadanedial.ts          ← CQ-Extended KadaneDial
│   │   ├── pruner.ts              ← Orchestrator
│   │   └── crypto.ts              ← AES-256-GCM encryption
│   ├── memory/
│   │   ├── hot/
│   │   │   └── tier1.ts           ← RAM rolling window
│   │   ├── warm/
│   │   │   ├── tier2.ts           ← Supabase adapter
│   │   │   └── extractor.ts       ← Llama-based fact extraction
│   │   └── cold/
│   │       ├── pinecone.ts        ← Vector store adapter
│   │       └── neo4j.ts           ← Graph store adapter
│   ├── audit/
│   │   ├── git-indexer.ts         ← Commit history indexer
│   │   ├── git-attestation.ts     ← Fact vs. Git checker
│   │   ├── llama-check.ts         ← Probabilistic spot-check
│   │   └── opus-escalation.ts     ← High-accuracy audit
│   ├── billing/
│   │   ├── recorder.ts            ← BillingRecord writer
│   │   ├── calculator.ts          ← Token delta math
│   │   └── invoice.ts             ← Monthly invoice generator
│   ├── dashboard/
│   │   └── index.html             ← Waste/savings dashboard
│   └── types/
│       ├── session.ts
│       ├── proxy.ts
│       ├── facts.ts
│       └── billing.ts
├── rust/
│   └── hot-path/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs             ← Token counting, string hashing via WASM
├── evals/
│   ├── datasets/
│   ├── harness/
│   ├── fixtures/
│   └── results/                   ← gitignored
├── scripts/
│   ├── capture-session.ts         ← Phase 0: raw session capture
│   └── promote-tier2-to-tier3.ts  ← Nightly promotion job
├── tests/
│   ├── unit/
│   ├── integration/
│   └── api/
├── supabase/
│   └── migrations/                ← All schema changes as SQL migrations
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── wrangler.toml                  ← Cloudflare Workers config
└── README.md
```

---

## Development Setup

### Prerequisites

- Node.js 22+
- Rust (for hot-path WASM)
- Docker (for Supabase local)
- Wrangler CLI (`npm install -g wrangler`)

### First-Time Setup

```bash
# Install dependencies
npm install

# Start Supabase locally
npx supabase start

# Run migrations
npx supabase db push

# Copy and fill environment variables
cp .env.example .env
# Edit .env with your actual keys

# Start the dev proxy
npm run dev
```

### Running Tests

```bash
npm run test          # unit + integration
npm run test:eval     # eval suite (slow — ~15 minutes)
npm run test:e2e      # end-to-end proxy flow
npm run lint          # eslint + prettier
npm run typecheck     # tsc --noEmit
```

All of these must pass before any commit to `main`.

---

## Code Standards

### TypeScript

- Strict mode. No `any`. No `// @ts-ignore`.
- Every exported function has JSDoc with `@param`, `@returns`, `@throws`.
- Errors use custom typed error classes, not raw `throw new Error("string")`.
- All async functions: explicit try/catch, no unhandled promise rejections.

```typescript
/**
 * Counts exact tokens for an Anthropic API request.
 * @param messages - The message array to count
 * @param model - The Anthropic model ID
 * @returns Exact input token count
 * @throws {TokenCountError} If the Anthropic token counting API fails
 */
export async function countTokens(
  messages: MessageParam[],
  model: string
): Promise<number> {
  // ...
}
```

### Naming

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions, variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types/Interfaces: `PascalCase`

### Git Commits

Format: `type(scope): description`

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`

Examples:
```
feat(pruner): implement CQ-Extended KadaneDial with time-based decay
fix(billing): use exact token count, not estimate
docs(algorithm): add edge case for σ=0 normalization
test(eval): add long-dormant session scenario to Tier B
```

---

## Adding a New Fact Type

1. Define the TypeScript interface extending `BaseFact` in `src/types/facts.ts`
2. Add the Zod schema in `src/memory/warm/schemas.ts`
3. Write the Supabase migration in `supabase/migrations/YYYYMMDDHHMMSS_add_X_fact.sql`
4. Add the extractor case in `src/memory/warm/extractor.ts`
5. Add the Neo4j node type in `src/memory/cold/neo4j.ts`
6. Write unit tests: happy path, null commit hash, confidence below threshold, Zod validation failure
7. Add a Tier B eval scenario that exercises the new fact type
8. Update `docs/TECHNICAL_SPEC.md` with the new schema
9. Update `docs/MEMORY_ARCHITECTURE.md` if the fact type has special retrieval behavior

---

## Architecture Decision Records (ADRs)

Any significant design decision must have an ADR in `docs/decisions/`. Use this template:

```markdown
# ADR-NNNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context

What problem are we solving? What constraints exist?

## Decision

What did we decide to do?

## Consequences

What are the tradeoffs? What does this make harder?

## Alternatives Considered

What else did we consider and why did we reject it?
```

ADRs are numbered sequentially. Never delete an ADR — if a decision is reversed, mark it Deprecated and write a new ADR.

### Existing ADRs (read before making related decisions)

| ADR | Decision |
|---|---|
| 0001 | Supabase (Postgres) over SQLite |
| 0002 | Time-based (hours) over turn-count temporal decay |
| 0003 | Hybrid-local pruning for ZK-Context compatibility |
| 0004 | No LLM summarization — structured facts only |
| 0005 | Cloudflare Workers over traditional Node server |
| 0006 | Dual cold storage: Pinecone (vector) + Neo4j (graph) |
| 0007 | Llama 4-8B for fact extraction over Opus or rule-based |

---

## Pull Request Checklist

Before opening a PR:

- [ ] All tests pass (`npm run test`)
- [ ] Eval suite passes if pruning logic changed (`npm run test:eval`)
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] New public functions have JSDoc
- [ ] If a schema changed, a migration exists in `supabase/migrations/`
- [ ] If a design decision was made, an ADR exists in `docs/decisions/`
- [ ] `docs/ROADMAP.md` phase checklist updated if a task was completed

---

## Security Vulnerabilities

Report to `security@startum.com`. Do not open a public GitHub issue.
