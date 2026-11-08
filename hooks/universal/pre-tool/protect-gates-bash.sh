#!/usr/bin/env bash
# hooks/universal/pre-tool/protect-gates-bash.sh: protect-gates.sh for a Bash command. run-hook.mjs passes only the command, so this adds --command (AC-28).
exec node "$(dirname "$0")/protect-gates.mjs" "$1" --command
