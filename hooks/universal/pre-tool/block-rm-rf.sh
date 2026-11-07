#!/usr/bin/env bash
# hooks/universal/pre-tool/block-rm-rf.sh
#
# Blocks rm -rf and similarly destructive commands outside the project root
# and outside /tmp. The agent should never need to recursively delete from
# system paths.

set -euo pipefail
# Claude Code blocks only on exit 2, so any unexpected failure blocks too.
trap 'exit 2' ERR

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
    # rm with a recursive option anywhere among its words, combined or split,
    # before or after a path (GNU rm accepts rm /x -r), up to the next ; & or |
    # (rm -rf, rm -r -f, rm -f -R, rm --force --recursive, /bin/rm -r).
    "(^|[^[:alnum:]_.-])rm([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+(-[[:alpha:]]*[rR][[:alpha:]]*|--recursive)([[:space:]]|$)"
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

# A target this hook cannot read literally ($HOME, `cmd`, $(cmd), ~user) could name
# any path, so a destructive command holding one is refused.
if [[ "$COMMAND" == *'$'* || "$COMMAND" == *'`'* || "$COMMAND" =~ (^|[[:space:]=])~ ]]; then
    echo "DevOPs RM BLOCK: destructive command with a variable, substitution or ~ target, which this hook cannot resolve." >&2
    echo "  Command: $COMMAND" >&2
    exit 2
fi
# A glob (rm -rf *, rm -rf /*) names paths this hook never sees, so a recursive
# rm holding one is refused.
# Glob characters, matched through a variable so Semgrep's bash parser can
# read the test.
GLOB_CHARS='[*?[]'
if [[ "$COMMAND" =~ (^|[^[:alnum:]_.-])rm[[:space:]] && "$COMMAND" =~ $GLOB_CHARS ]]; then
    echo "DevOPs RM BLOCK: destructive rm with a glob target, which this hook cannot resolve." >&2
    echo "  Command: $COMMAND" >&2
    exit 2
fi

# Collapse . and .. so ../ cannot climb out of the project while the path still
# starts with the project root; paths compare by directory boundary, not prefix.
normalise() {
    local part out=() IFS=/
    set -f
    for part in $1; do
        # Empty and "." components add nothing. (An empty case pattern is
        # valid bash but breaks Semgrep's bash parser.)
        [[ -z "$part" || "$part" == "." ]] && continue
        case "$part" in
            ..) if (( ${#out[@]} )); then unset 'out[${#out[@]}-1]'; out=("${out[@]}"); fi ;;
            *) out+=("$part") ;;
        esac
    done
    set +f
    printf '/%s' "${out[*]-}"
}
inside() { [[ "$1" == "$2" || "$1" == "$2/"* ]]; }

# Extract target paths from rm commands
# This is heuristic — extract everything that looks like a path argument
targets=$(echo "$COMMAND" | grep -oE '(/?[a-zA-Z0-9_./\-]+)' | grep -v '^-' || true)

set -f
for target in $targets; do
    # Resolve to a normalised absolute path
    if [[ "$target" == /* ]]; then
        abs_target="$(normalise "$target")"
    else
        abs_target="$(normalise "$PROJECT_ROOT/$target")"
    fi

    # Skip obvious non-paths
    if [[ "$target" == "rm" || "$target" == "find" || ( ${#target} -lt 2 && "$target" != "." ) ]]; then
        continue
    fi

    in_allowed=false
    # The project root, a directory that contains it, / and the shared temp
    # roots themselves are never allowed targets, even when the project lives
    # under /tmp.
    if [[ "$abs_target" == "/" || "$abs_target" == "/tmp" || "$abs_target" == "/var/tmp" ]] ||
        inside "$PROJECT_ROOT" "$abs_target"; then
        protected=true
    else
        protected=false
        for allowed in "${ALLOWED_ROOTS[@]}"; do
            if inside "$abs_target" "$allowed"; then
                in_allowed=true
                break
            fi
        done
    fi

    # Inside the project but not the project root itself: allowed, and logged.
    if [[ "$protected" == "false" && "$in_allowed" == "false" ]] && inside "$abs_target" "$PROJECT_ROOT"; then
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
