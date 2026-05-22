# Multi-Tool Failover

See `skills/universal/process/multi-tool-failover/SKILL.md` for the active
skill.

## Workflow

```
Tool A approaches limit
        │
        ▼
   /checkpoint           # invokes baton-handoff skill
        │
        ▼
.workflow/state/baton.md written
        │
        ▼
   open Tool B
        │
        ▼
   session-start hook reads baton
        │
        ▼
   continue from next_action
```

## Supported tools

| Tool | Adapter |
|------|---------|
| Claude Code | CLAUDE.md (sources AGENTS.md) |
| Codex CLI | AGENTS.md (native) |
| Cursor | .cursorrules generated |
| Antigravity | AGENTS.md (native) |
| Kiro | AGENTS.md + steering files |
| Gemini CLI | GEMINI.md generated |
| Copilot | copilot-instructions.md generated |
| Windsurf | .windsurfrules generated |
| Aider | CONVENTIONS.md generated |
| OpenCode | CLAUDE.md compatible |

## Local LLM fallback

For runaway-cost prevention or air-gapped work, use OpenCode + Ollama or
LM Studio. The same baton works.
