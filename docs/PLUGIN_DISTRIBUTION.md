# Plugin Distribution

DevOPs ships as a Claude Code plugin via `.claude-plugin/plugin.json`.

## Installation methods

### Method 1: Plugin command
```
/plugin install devops
```
(once the plugin is published to a marketplace)

### Method 2: npm (0.4.0 and later)
```bash
npm install -g @miltonadina/devops
```
or run any command once with `npx @miltonadina/devops <command>`.

### Method 3: a clone of this repository
```bash
git clone https://github.com/MILTONADINA/DevOPs.git
cd DevOPs && npm ci
node scripts/devops-cli.js help
```

## Per-project install

After installing, per project:
```bash
cd ~/my-project
devops analyze
devops init
```

## Cross-tool support

The same install works for Codex, Cursor, Antigravity, Kiro, Gemini CLI,
Copilot, Windsurf, Aider, OpenCode via the AGENTS.md universal contract.
