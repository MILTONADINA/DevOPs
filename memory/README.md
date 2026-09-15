# Memory

DevOPs supports two memory backends. Both can be active simultaneously and
serve different purposes. (A third, Zep, was removed 2026-09-14 as redundant
dead weight — zero call sites ever wired it in, and Stratum's own ADR-0004
argues its NL-summarization/graph approach is inferior to the structured-facts
approach below. Semantic-temporal queries — "what did anyone ever say about
X?" — are currently unsupported; reopen if that need is confirmed.)

## The two tiers

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

## When to use which

| Need | Backend |
|------|---------|
| "What was the auth decision?" | file-based (decisions.md) |
| "What did we change in auth.ts in this session?" | Stratum (function_changes) |
| "Show me the audit trail for client X's spend" | Stratum (billing_records) |
| "What's the project glossary entry for 'session'?" | file-based (glossary.md) |
| "Has anyone in any session ever discussed X?" / "what did the user say N weeks ago?" | **unsupported** — was Zep's job, removed; no current backend covers open-ended semantic-temporal recall |

## Configuration

Each backend's directory has its own README:
- `memory/file-based/README.md`
- `memory/stratum/README.md`

## Cross-project meta-memory

The `meta-memory/` directory (separate from this one) stores PII-scrubbed
patterns that cross client boundaries: "tech decisions made on similar
projects," "recommended starter stacks," etc. See `meta-memory/README.md`.
