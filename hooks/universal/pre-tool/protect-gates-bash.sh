#!/usr/bin/env bash
# hooks/universal/pre-tool/protect-gates-bash.sh: protect-gates.sh for a Bash command. run-hook.mjs passes only the command, so this adds --command (AC-28). The command goes to protect-gates.mjs on stdin, not argv, so a long command is checked too (AC-31).
printf '%s' "$1" | node "$(dirname "$0")/protect-gates.mjs" --stdin --command
