# MCP Configurations

JSON configs for MCP (Model Context Protocol) servers DevOPs uses.

## Universal MCPs

- **memory-stratum** — Stratum structured fact store
- **memory-zep** — Zep semantic temporal memory
- **playwright** — browser automation for full-stack UI verification

## Installation

Claude Code:
```bash
claude mcp add-json $(cat mcp-configs/universal/playwright.json)
```

Codex CLI: place the JSON in `~/.codex/mcp/`.

## Per-project additions

Project-specific MCPs (e.g., Stripe MCP for e-commerce projects, GitHub MCP
for repo automation) are added by the analyzer based on detected stack.
