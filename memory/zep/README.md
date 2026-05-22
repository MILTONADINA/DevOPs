# Zep Memory Backend

Self-hosted Zep for semantic temporal memory. Use for cross-session recall
of conversational context that doesn't fit cleanly into structured facts.

## When to use Zep vs. the other tiers

- **Use file-based** for durable, hand-curated decisions and project glossary.
- **Use Stratum** for structured facts, cost ledger, audit trail.
- **Use Zep** for "what did the user say about X three weeks ago?" — temporal
  semantic queries.

## Setup (self-hosted via Docker Compose)

```bash
cd memory/zep
docker-compose up -d
```

This brings up:
- Zep server (port 8000)
- Postgres (Zep's metadata store)
- Embedder

## Wire to your tool

Zep is exposed via MCP. The config is at
`mcp-configs/universal/memory-zep.json`. In Claude Code:

```bash
claude mcp add zep-memory --command "npx -y @agentmemory/zep-mcp"
```

Or copy `memory-zep.json` into your tool's MCP config dir.

## Usage

The Zep MCP exposes tools like:
- `zep.add_memory(session_id, message)` — record a message
- `zep.search_memory(query, limit)` — semantic search across all sessions
- `zep.get_session_facts(session_id)` — extracted structured facts for a session

## Per-tenant scoping

Each user/client gets a separate Zep session group. Cross-tenant search is
blocked by Zep's authorization layer. Set `ZEP_TENANT_ID` env var per session.

## Privacy / compliance

Zep stores raw conversation content. Apply the same PII redaction as the
observability layer (see `observability/pii-redaction.ts`) before sending
content to Zep. Especially important under COPPA / GDPR / HIPAA.
