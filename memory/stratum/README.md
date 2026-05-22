# Stratum Memory Backend

Wires the DevOPs workflow into a running Stratum instance for structured
fact storage and per-tenant cost attribution.

## Status

| Stratum phase | Status (as of session) | DevOPs usage |
|---------------|------------------------|---------------|
| Phase 0 — capture proxy | ready | session/turn capture |
| Phase 0 — Supabase schema | ready | facts, audit, billing |
| Phase 1 — git attestation | ready | memory poisoning defense |
| Phase 2 — CQ-extended pruner | TODO | context pruning (token savings) |
| Phase 2 — Three-tier memory | TODO | hot/warm/cold tier routing |

DevOPs uses everything Stratum has ready today. Pruning is wired but pass-through
until Phase 2 ships.

## Wire it up

In any project directory:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080   # your Stratum instance
export STRATUM_API_KEY=<your-key>
export STRATUM_TENANT_ID=<client-id>              # per-client scoping
```

Claude Code, Codex, and any tool that respects ANTHROPIC_BASE_URL will route
through Stratum, which captures each turn and writes structured facts to
Supabase.

## What Stratum stores per session

- `sessions` row: session_id, tenant_id, started_at, ended_at, total_tokens, total_cost_usd
- `pruning_logs`: what was kept vs. dropped on each turn (when pruner active)
- `billing_records`: HMAC-signed append-only ledger entries
- `function_changes`: durable record of which functions changed and why
- `tech_decisions`: durable record of decisions (mirrors decisions.md)
- `policy_updates`: changes to rules / constraints
- `todos`: open items extracted from session transcripts
- `variable_changes`: state shifts within a session
- `audit_conflicts`: when a stated fact contradicts git history → flag

## How DevOPs reads it

The `session-start` hook calls Stratum to retrieve:
- Top N facts relevant to the current task (via Phase 1 cosine similarity)
- Unresolved `audit_conflicts` for this project
- Last 5 `tech_decisions` for context

## Memory poisoning defense

Stratum's git-attestation feature cross-references stated facts against the
project's git history. If the agent writes "we chose MongoDB" but git diff
shows Postgres being installed, that conflict is written to `audit_conflicts`
and DevOPs surfaces it on the next session start.

## Config

`config.yml` in this directory carries client-overridable settings.
