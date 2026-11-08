#!/usr/bin/env bash
# hooks/universal/pre-tool/protect-gates.sh
#
# Blocks an agent's file-tool write to DevOPs's gates and approvals (specs/release/npm-package.md
# AC-28): .claude/settings.json, .claude/settings.local.json, anything under .claude/hooks/,
# .workflow/state/approvals.jsonl, .workflow/state/install-manifest.json and anything under
# .workflow/state/originals/. The check is in protect-gates.mjs, beside this file.
#
#   protect-gates.sh <path>               a file tool's target path (Write, Edit, ...)
#   protect-gates.sh <command> --command  a Bash command (a heuristic; see docs/HOOKS.md)
#
# Exit 0 allows the call; exit 2 blocks it.

if [ "${2-}" = "--command" ]; then
    node "$(dirname "$0")/protect-gates.mjs" "$1" --command
else
    node "$(dirname "$0")/protect-gates.mjs" "$1"
fi
