# Plugin Distribution

DevOPs ships as a Claude Code plugin via `.claude-plugin/plugin.json`.

## Installation methods

### Method 1: Plugin command
```
/plugin install devops
```
(once the plugin is published to a marketplace)

### Method 2: Clone + install
```bash
git clone https://github.com/MILTONADINA/DevOPs.git ~/DevOPs
~/DevOPs/scripts/install.sh
```

### Method 3: npm/npx (when published)
```bash
npx @miltonadina/devops init
```

## Per-project install

After global install, per project:
```bash
cd ~/my-project
devops analyze
devops init
```

## Cross-tool support

The same install works for Codex, Cursor, Antigravity, Kiro, Gemini CLI,
Copilot, Windsurf, Aider, OpenCode via the AGENTS.md universal contract.
