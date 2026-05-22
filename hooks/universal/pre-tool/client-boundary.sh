#!/usr/bin/env bash
# hooks/universal/pre-tool/client-boundary.sh
#
# Enforces client data isolation: the agent may not read or write outside
# the current project root, unless the path is in an explicit allowlist.
#
# Required for multi-tenant work where one developer handles multiple
# clients. Prevents accidental cross-client data exposure.

set -euo pipefail

PATH_ARG="${1:-}"
OPERATION="${2:-access}"
PROJECT_ROOT="$(pwd)"

# Paths always allowed (read-only system resources)
ALLOWED_GLOBAL_READ=(
    "/etc/ssl/certs/"
    "/usr/share/"
    "/usr/lib/"
    "/usr/local/share/"
    "/opt/homebrew/"
    "/dev/null"
    "/dev/urandom"
    "/dev/random"
    "/tmp/"
    "/var/tmp/"
    "$HOME/.DevOPs/"
    "$HOME/.cache/"
    "$HOME/.npm/"
    "$HOME/.cargo/"
    "$HOME/.rustup/"
    "$HOME/.pyenv/"
    "$HOME/.nvm/"
    "$HOME/.local/share/"
    "$HOME/.gitconfig"
)

# Resolve to absolute path
if [[ "$PATH_ARG" == /* ]]; then
    abs_path="$PATH_ARG"
else
    abs_path="$PROJECT_ROOT/$PATH_ARG"
fi

# Within project root → always OK
if [[ "$abs_path" == "$PROJECT_ROOT"* ]]; then
    exit 0
fi

# Check against global allowlist (read-only only)
if [[ "$OPERATION" == "read" ]]; then
    for allowed in "${ALLOWED_GLOBAL_READ[@]}"; do
        if [[ "$abs_path" == "$allowed"* ]]; then
            exit 0
        fi
    done
fi

# Check for per-project allowlist
PROJECT_ALLOWLIST="$PROJECT_ROOT/.workflow/client/path-allowlist.txt"
if [[ -f "$PROJECT_ALLOWLIST" ]]; then
    while IFS= read -r allowed; do
        [[ -z "$allowed" || "$allowed" =~ ^#.*$ ]] && continue
        # Expand $HOME and other vars
        allowed_expanded=$(eval echo "$allowed")
        if [[ "$abs_path" == "$allowed_expanded"* ]]; then
            exit 0
        fi
    done < "$PROJECT_ALLOWLIST"
fi

# Blocked
cat >&2 <<EOF
DevOPs CLIENT BOUNDARY BLOCK
  Operation:    $OPERATION
  Path:         $abs_path
  Project root: $PROJECT_ROOT

This path is outside the current project's boundary. The DevOPs client
isolation policy blocks cross-project access by default.

If this access is intentional and authorized, add the path (or its parent
directory) to .workflow/client/path-allowlist.txt, document the rationale,
and re-run.

If this looks like an agent attempting to read another client's data,
report this to your team lead before raising the allowlist.
EOF

mkdir -p .workflow/state
echo "{\"ts\":$(date -u +%s),\"event\":\"boundary_blocked\",\"path\":\"$abs_path\",\"operation\":\"$OPERATION\"}" >> .workflow/state/events.jsonl

exit 2
