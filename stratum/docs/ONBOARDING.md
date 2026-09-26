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
- Docker with Compose (Docker Desktop or Docker Engine) for the local Supabase-compatible stack
- Git

```bash
# Clone (Stratum lives in the stratum/ directory of the DevOPs repository)
git clone https://github.com/MILTONADINA/DevOPs.git
cd DevOPs/stratum

# Install Node dependencies
npm ci

# Start the local database stack (requires Docker running). This starts the
# project Compose stack on 127.0.0.1:54321 and applies pending migrations.
npm run db:start
# Alternative: `npm run setup` from the repository root installs Stratum's
# dependencies if needed, starts the database, and runs a proxy startup
# smoke check in one step.

# Copy the environment template
cp .env.example .env
```

Use your own LLM provider account. Any usage charges come from that provider,
not from this project, and a local OpenAI-compatible server (for example
Ollama, via `CQ_LOCAL_BASE_URL`) needs no paid key. The proxy reads provider
settings from its process environment, not from `.env`; some operator
scripts load `.env`. Never put the local service JWT in `.env`: run commands
that need the database through `npm run db:with-env -- <command>`, which
supplies it (`docs/runbooks/LOCAL_STRATUM.md` at the repository root).

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
7. **No SQLite:** the local Supabase-compatible Compose stack (Postgres). There is no hosted database (ADR-0020); Stratum runs on the user's machine.
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

If any of these feel shaky, re-read the relevant doc. Ask questions in a GitHub issue (https://github.com/MILTONADINA/DevOPs/issues) — but check the docs first.
