# ONBOARDING.md — New Developer Setup

Welcome to Startum. This document gets you from zero to a working local environment and oriented in the codebase. Read it fully before asking questions — most answers are here.

---

## Day 1 Checklist

### 1. Read These Docs First (in order)

- [ ] `README.md` — project summary and quick start
- [ ] `docs/BLUEPRINT.md` — the architecture, design principles, and system invariants
- [ ] `docs/ROADMAP.md` — which phase is active right now and what the acceptance criteria are
- [ ] `.claude/CLAUDE.md` — the rules for the codebase (Claude Code reads this; you should too)
- [ ] `docs/GLOSSARY.md` — the vocabulary. Every term has a precise meaning here.

Do not skip any of these. Startum has non-obvious design decisions that will make you write wrong code if you don't understand them first. The most common mistake: reaching for LLM summarization as a memory solution. It is prohibited. Read `docs/decisions/0004-no-llm-summarization.md` before touching any memory code.

### 2. Local Environment Setup

**Prerequisites:**
- Node.js 22+ (`node --version`)
- Rust (`rustc --version`) — for hot-path WASM
- Docker Desktop (for Supabase local)
- Git

```bash
# Clone
git clone https://github.com/your-org/startum
cd startum

# Install Node dependencies
npm install

# Start Supabase locally (requires Docker running)
npx supabase start

# Apply database migrations
npx supabase db push

# Copy and configure environment
cp .env.example .env
# Edit .env — ask the team for development keys
```

### 3. Verify the Setup

```bash
# Type check
npm run typecheck   # should output: zero errors

# Lint
npm run lint        # should output: zero warnings

# Unit tests
npm run test        # should pass

# Start the dev proxy
npm run dev
# → Proxy running at http://localhost:4080

# In another terminal, verify it's alive
curl http://localhost:4080/health
# → {"status":"ok",...}
```

### 4. Run a Captured Session (Phase 0)

```bash
# Start the capture proxy
npm run capture

# In a new terminal, point Claude Code at it
export ANTHROPIC_BASE_URL=http://localhost:4090
claude   # run a short Claude Code session

# Press Ctrl+C in the capture terminal
# Check the output: data/sessions/session-<uuid>.json
```

Open the JSON and look at the raw API traffic. This is the most important thing you can do in your first week. Understanding what the data actually looks like is prerequisite to everything else.

---

## Codebase Orientation

### Most Important Files

| File | Why it matters |
|---|---|
| `src/proxy/index.ts` | Entry point — where requests arrive |
| `src/pruner/kadanedial.ts` | The algorithm — the mathematical core |
| `src/pruner/encoder.ts` | ONNX model — performance-critical path |
| `src/memory/warm/extractor.ts` | Fact extraction — the alternative to summarization |
| `src/audit/git-attestation.ts` | Ground truth verification |
| `src/billing/recorder.ts` | Billing integrity — touch this with care |
| `src/types/` | All TypeScript interfaces — read these before implementing anything |

### Files That Require Extra Care

**`src/billing/recorder.ts`** — billing records are append-only with HMAC signing. Any bug here has financial consequences. No `any` types. Full test coverage required. Every change requires a second reviewer.

**`src/pruner/kadanedial.ts`** — any change requires running the full eval suite before committing. Read `docs/ALGORITHM.md` completely before touching this file.

**`src/proxy/tee/`** — security-critical. Changes require an ADR and a security review. The invariant "raw context never logged outside the enclave" must hold after every change.

### What Phase Are We In?

Check `docs/ROADMAP.md` — the active phase is at the top. Do not build Phase N+1 features until Phase N acceptance criteria are checked off. This is a hard rule.

---

## Development Workflow

### Starting Work

```bash
# Always start from main
git checkout main
git pull

# Create a feature branch
git checkout -b feat/your-feature-name
```

### Before Every Commit

```bash
npm run typecheck   # zero errors required
npm run lint        # zero warnings required
npm run test        # all pass required

# If you changed anything in src/pruner/:
npm run test:eval   # eval suite must pass
```

### Commit Message Format

`type(scope): description`

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`

```
feat(pruner): implement temporal decay with hour-based exponent
fix(billing): use exact token count from Anthropic SDK, not estimate
test(eval): add stale-API-key scenario to Tier B dataset
docs(algorithm): clarify σ=0 edge case handling
```

### Pull Request Requirements

- All checks pass (CI will verify)
- New exported functions have JSDoc
- If a design decision was made → ADR exists in `docs/decisions/`
- If a schema changed → migration exists in `supabase/migrations/`
- Roadmap checklist updated if a task was completed

---

## Key Rules (No Exceptions)

These are the non-negotiable rules from `.claude/CLAUDE.md`. Memorize them:

1. **Token counting:** Use `@anthropic-ai/sdk` only. Never `tiktoken`. Never estimates.
2. **Memory storage:** Structured facts only. Never ask an LLM to summarize.
3. **Temporal decay:** Use time-based (hours), not turn-count-based. Sessions span days.
4. **Encryption:** Raw context never stored or logged outside the TEE.
5. **Billing records:** Append-only. Never modify after writing. Test this invariant explicitly.
6. **Eval gate:** Any change to pruning logic must pass the eval suite before merge.
7. **No SQLite:** Supabase local (Postgres) for development, Supabase hosted for production.
8. **No `any` types:** TypeScript strict mode. Zero exceptions.

---

## Getting Help

**Architecture questions:** Re-read `docs/BLUEPRINT.md` and the relevant `docs/decisions/` ADRs first.

**Algorithm questions:** `docs/ALGORITHM.md` and the DyCP paper (arXiv:2601.07994) are authoritative.

**Schema questions:** `docs/TECHNICAL_SPEC.md` and the migration files in `supabase/migrations/`.

**Security questions:** `docs/SECURITY.md` — especially the threat model table.

If the answer isn't in the docs, the docs need to be updated. Write the answer you find, then add it to the appropriate file.

---

## First Week Goals

By the end of your first week, you should be able to:

1. Run the capture script and explain what each field in the output JSON means
2. Explain the KadaneDial algorithm in your own words (not from the docs — from understanding)
3. Explain why we use time-based decay instead of turn-count decay
4. Explain why we don't use LLM summarization
5. Write a Zod schema for a new fact type (without looking at existing ones)
6. Know which phase is active and what the next acceptance criterion to hit is

If any of these feel shaky, re-read the relevant doc. Ask questions in the team chat — but check the docs first.
