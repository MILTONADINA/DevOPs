# Hooks Reference

Deterministic safety layer. Hooks fire regardless of agent intent. Cannot be
disabled by the agent.

## Universal hooks

### Pre-tool (fire before every tool call)

| Hook | Purpose | Blocks on |
|------|---------|-----------|
| `budget-brake.sh` | Hard USD ceiling with reserve-commit | Session/hour/day cap exceeded |
| `loop-detection.sh` | Repetition + stasis detection | Same call N times OR scratchpad stasis |
| `block-secrets.sh` | File access blocklist | Sensitive paths (.env, .pem, ssh) |
| `block-prod-write.sh` | Production write blocker | git push main, kubectl prod, terraform apply without approval |
| `block-rm-rf.sh` | Destructive command blocker | rm -rf outside whitelisted paths |
| `client-boundary.sh` | Cross-project access blocker | Paths outside project root |

### Post-tool (fire after every file write)

| Hook | Purpose |
|------|---------|
| `auto-format.sh` | Run biome/prettier/ruff/rustfmt/gofmt/shfmt |
| `gitleaks-scan.sh` | Detect secrets in just-written file |

### Session-start

| Hook | Purpose |
|------|---------|
| `load-baton.sh` | Read baton if recent, print status, verify profile |

### Session-end

| Hook | Purpose |
|------|---------|
| `write-baton.sh` | Compose handoff document |

## Adding hooks

See `CONTRIBUTING.md`. Hooks must:
- Exit cleanly (no hangs)
- Complete in < 500ms p99
- Log to `.workflow/state/events.jsonl`
- Be idempotent

## Platform requirements

The `.sh` hooks under `hooks/` and `scripts/` use a Bash shebang
(`#!/usr/bin/env bash`) and POSIX shell semantics. They require a POSIX
shell (bash/zsh), which macOS and Linux provide natively. Configure Claude
Code (or the active agent) to invoke the hooks with `bash <hook>.sh`.
