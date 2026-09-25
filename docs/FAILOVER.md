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
   session-start hook reports the baton's age;
   the agent reads the baton
        │
        ▼
   continue from ## Next action
```

## Supported tools

| Tool | Adapter |
|------|---------|
| Claude Code | CLAUDE.md (sources AGENTS.md) |
| Codex CLI | AGENTS.md (native) |
| Cursor | .cursorrules (write from AGENTS.md) |
| Antigravity | AGENTS.md (native) |
| Kiro | AGENTS.md + steering files |
| Gemini CLI | GEMINI.md (write from AGENTS.md) |
| Copilot | .github/copilot-instructions.md (write from AGENTS.md) |
| Windsurf | .windsurfrules (write from AGENTS.md) |
| Aider | CONVENTIONS.md (write from AGENTS.md) |
| OpenCode | CLAUDE.md compatible |

Nothing in DevOPs generates these adapter files; before switching to a tool
that needs one, write it from AGENTS.md.

## Local LLM fallback

For runaway-cost prevention or air-gapped work, use OpenCode + Ollama or
LM Studio. The same baton works.
