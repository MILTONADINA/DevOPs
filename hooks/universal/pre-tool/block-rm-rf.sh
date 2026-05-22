#!/usr/bin/env bash
# hooks/universal/pre-tool/block-rm-rf.sh
#
# Blocks rm -rf and similarly destructive commands outside the project root
# and outside /tmp. The agent should never need to recursively delete from
# system paths.

set -euo pipefail

COMMAND="${1:-}"

# Allowed deletion roots (relative or absolute paths within these are OK)
PROJECT_ROOT="$(pwd)"
ALLOWED_ROOTS=(
    "$PROJECT_ROOT/node_modules"
    "$PROJECT_ROOT/.next"
    "$PROJECT_ROOT/.turbo"
    "$PROJECT_ROOT/dist"
    "$PROJECT_ROOT/build"
    "$PROJECT_ROOT/target"
    "$PROJECT_ROOT/coverage"
    "$PROJECT_ROOT/.workflow/state"  # allow clearing transient state
    "/tmp"
    "/var/tmp"
)

# Destructive patterns
DESTRUCTIVE_PATTERNS=(
    "rm[[:space:]]+-[^[:space:]]*r[^[:space:]]*f"
    "rm[[:space:]]+-[^[:space:]]*f[^[:space:]]*r"
    "rm[[:space:]]+--recursive[[:space:]]+--force"
    "rm[[:space:]]+--force[[:space:]]+--recursive"
    "find[[:space:]].*-delete"
    "find[[:space:]].*-exec[[:space:]]+rm"
    "shred"
    "wipefs"
    "dd[[:space:]]+if=.*of=/dev/"
    "mkfs"
    ":(\)\{[[:space:]]*:\|:&[[:space:]]*\}\;:" # fork bomb
)

is_destructive=false
matched=""
for p in "${DESTRUCTIVE_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$p"; then
        is_destructive=true
        matched="$p"
        break
    fi
done

if [[ "$is_destructive" == "false" ]]; then
    exit 0
fi

# Special cases that are always blocked regardless of target
if echo "$COMMAND" | grep -qE "rm[[:space:]]+-[^[:space:]]*[rf].*[[:space:]]/$|rm[[:space:]]+-[^[:space:]]*[rf].*[[:space:]]/[[:space:]]*$"; then
    echo "DevOPs RM BLOCK: 'rm -rf /' or equivalent. Absolutely not." >&2
    exit 2
fi

if echo "$COMMAND" | grep -qE ":(\)\{[[:space:]]*:\|:&[[:space:]]*\}\;:"; then
    echo "DevOPs RM BLOCK: fork bomb signature. Refused." >&2
    exit 2
fi

# Extract target paths from rm commands
# This is heuristic — extract everything that looks like a path argument
targets=$(echo "$COMMAND" | grep -oE '(/?[a-zA-Z0-9_./\-]+)' | grep -v '^-' || true)

for target in $targets; do
    # Resolve to absolute path
    if [[ "$target" == /* ]]; then
        abs_target="$target"
    else
        abs_target="$PROJECT_ROOT/$target"
    fi

    # Skip obvious non-paths
    if [[ "$target" == "rm" || "$target" == "find" || ${#target} -lt 2 ]]; then
        continue
    fi

    in_allowed=false
    for allowed in "${ALLOWED_ROOTS[@]}"; do
        if [[ "$abs_target" == "$allowed"* ]]; then
            in_allowed=true
            break
        fi
    done

    if [[ "$in_allowed" == "false" && "$abs_target" == "$PROJECT_ROOT"* ]]; then
        # Within project but outside known transient dirs — allow with logging
        mkdir -p .workflow/state
        echo "{\"ts\":$(date -u +%s),\"event\":\"destructive_in_project\",\"target\":\"$abs_target\",\"command\":$(echo "$COMMAND" | jq -R . 2>/dev/null || echo "\"$COMMAND\"")}" >> .workflow/state/events.jsonl
        continue
    fi

    if [[ "$in_allowed" == "false" ]]; then
        cat >&2 <<EOF
DevOPs RM BLOCK: refused destructive operation
  Command: $COMMAND
  Target outside project + allowed roots: $abs_target
  Matched pattern: $matched

Allowed destructive targets:
$(printf '  %s\n' "${ALLOWED_ROOTS[@]}")

If you need to delete this path, do it outside the agent session.
EOF
        mkdir -p .workflow/state
        echo "{\"ts\":$(date -u +%s),\"event\":\"rm_blocked\",\"target\":\"$abs_target\"}" >> .workflow/state/events.jsonl
        exit 2
    fi
done

exit 0
