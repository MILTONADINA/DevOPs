# Memory

DevOPs supports three memory backends. All three can be active simultaneously
and serve different purposes.

## The three tiers

### 1. File-based memory (always on)

Location: `memory/file-based/` (committed to git per project)

What it stores:
- `decisions.md` — durable architectural decisions
- `architecture.md` — system shape, why things are the way they are
- `glossary.md` — project-specific terms
- `facts/` — hand-curated facts that don't fit elsewhere

Pros: durable, reviewable, git-attested by definition.
Cons: not semantically searchable; manual curation.

Read on every session start. Updated by humans + agent with PR.

### 2. Stratum (structured fact store, recommended)

Location: `memory/stratum/` (config only — real data in Stratum's Supabase)

What it stores (via Stratum's schema):
- `sessions` — every agent session captured
- `pruning_logs` — what context was kept vs. dropped
- `billing_records` — append-only HMAC-signed cost ledger
- Fact tables: `function_changes`, `tech_decisions`, `policy_updates`,
  `todos`, `variable_changes`
- `audit_conflicts` — when stated facts disagree with git history
- `api_keys` — vaulted secrets

Wire via env var:
```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
```

Pros: structured, queryable, cryptographically audited, per-tenant scoped.
Cons: requires running the Stratum proxy.

Status: Phase 0 (capture) works today. Phase 2 (pruning) is in progress.

### 3. Zep (semantic temporal memory)

Location: `memory/zep/` (Docker Compose + MCP config)

What it stores:
- Conversation turns embedded for semantic search
- Time-aware retrieval ("what did we decide last week about auth?")
- Graph relationships between facts

Wire via MCP: `mcp-configs/universal/memory-zep.json`

Pros: best temporal-reasoning benchmark scores in 2026; semantic search.
Cons: external dependency; embeddings cost.

## When to use which

| Need | Backend |
|------|---------|
| "What was the auth decision?" | file-based (decisions.md) |
| "What did we change in auth.ts in this session?" | Stratum (function_changes) |
| "Has anyone in any session ever discussed Argon2id?" | Zep |
| "Show me the audit trail for client X's spend" | Stratum (billing_records) |
| "Recall what the user said about retry policy 3 weeks ago" | Zep |
| "What's the project glossary entry for 'session'?" | file-based (glossary.md) |

## Configuration

Each backend's directory has its own README:
- `memory/file-based/README.md`
- `memory/stratum/README.md`
- `memory/zep/README.md`

## Cross-project meta-memory

The `meta-memory/` directory (separate from this one) stores PII-scrubbed
patterns that cross client boundaries: "tech decisions made on similar
projects," "recommended starter stacks," etc. See `meta-memory/README.md`.
