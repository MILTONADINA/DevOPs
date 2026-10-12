# MCP Configurations

JSON configs for MCP (Model Context Protocol) servers DevOPs uses.

## Universal MCPs

- **memory-stratum** — Stratum structured fact store
- **playwright** — browser automation for full-stack UI verification
- **agile-graph** — Agile Graph (MIT, https://github.com/MILTONADINA/agile-graph)
  project context for Claude Code. Its four tools are pinned by
  `agile-graph.tool-hashes.json` for `@agile-graph/engine` 0.1.0, and it exposes no run
  tools. `devops init` registers it in the project's `.mcp.json` when the engine is
  installed (`specs/graph/agile-graph-link.md`). Before Claude Code can use it, choose
  what it may receive and build the index, from the project root:

  ```bash
  GRAPH_ENGINE_NO_FEEDBACK=1 agile-graph -C . init --cloud-mcp --export '<glob>'
  GRAPH_ENGINE_NO_FEEDBACK=1 agile-graph -C . index --lexical
  ```

  The engine's automatic feedback is on by default but can only send when a project's
  policy allows `api.github.com`. `GRAPH_ENGINE_NO_FEEDBACK=1` turns it off completely;
  the template sets it for the server too.

## Installation

Claude Code:
```bash
claude mcp add-json playwright "$(jq -c 'del(.name, .description)' mcp-configs/universal/playwright.json)"
```

Codex CLI: place the JSON in `~/.codex/mcp/`.

## Per-project additions

Project-specific MCPs (e.g., Stripe MCP for e-commerce projects, GitHub MCP
for repo automation) are added by the analyzer based on detected stack.
