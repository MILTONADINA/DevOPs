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

json_escape() {
    local s="$1" out="" i c code hex
    for (( i = 0; i < ${#s}; i++ )); do
        c="${s:i:1}"
        case "$c" in
            "\\") out+='\\' ;;
            '"') out+='\"' ;;
            *)
                printf -v code '%d' "'$c"
                if (( code >= 0 && code < 32 )); then
                    case "$code" in
                        8) out+='\b' ;;
                        9) out+='\t' ;;
                        10) out+='\n' ;;
                        12) out+='\f' ;;
                        13) out+='\r' ;;
                        *) printf -v hex '\\u%04x' "$code"; out+="$hex" ;;
                    esac
                else
                    out+="$c"
                fi
                ;;
        esac
    done
    printf '%s' "$out"
}

# json_escape of at most 4096 characters of $1. json_escape takes time quadratic in its input, so a
# 1 MB command would take minutes to log. A longer value is cut and marked with its length (AC-31).
# Whether text $3 matches extended regex $2, with grep flags $1. The text goes through a pipe, not a
# here-string: bash 3.2 writes a here-string to a temp file, and a temp file it cannot create would
# read as no match. grep's own status decides (PIPESTATUS, so the printf's SIGPIPE when grep -q quits
# early is ignored): 0 matches, 1 does not, anything else blocks (AC-31).
matches() {
    local status=0
    printf '%s\n' "$3" | grep -q "$1" -e "$2" || status=${PIPESTATUS[1]}
    [[ "$status" == 0 ]] && return 0
    [[ "$status" == 1 ]] && return 1
    echo "DevOPs RM BLOCK: grep failed with status $status while checking the command -- failing closed" >&2
    exit 2
}

log_text() {
    local s="$1"
    if (( ${#s} > 4096 )); then s="${s:0:4096}...[${#s} chars]"; fi
    json_escape "$s"
}

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
)

# A fork bomb: a function that pipes itself into itself in the background, in either definition
# form (name() { ... } or function name { ... }), with any name and spacing. The definition alone
# is matched, so every way of invoking it is caught. Newlines are joined first, so a multi-line
# definition matches too. Like every pattern here, this reads the command text only: a fork bomb
# built at run time is not caught.
FORK_BOMB='(^|[^[:alnum:]_:])(function[[:space:]]+)?([[:alnum:]_:]+)[[:space:]]*([(][[:space:]]*[)])?[[:space:]]*[{][[:space:]]*\3([[:space:]]+[^;|{}]*)?[[:space:]]*[|][[:space:]]*\3([[:space:]]+[^;|{}]*)?&'
# The fork-bomb text is flattened first.
flat_command="$(printf '%s' "$COMMAND" | tr '\n' ' ')"
if matches -E "$FORK_BOMB" "$flat_command"; then
    echo "DevOPs RM BLOCK: fork bomb signature. Refused." >&2
    exit 2
fi

is_destructive=false
matched=""
for p in "${DESTRUCTIVE_PATTERNS[@]}"; do
    if matches -E "$p" "$COMMAND"; then
        is_destructive=true
        matched="$p"
        break
    fi
done

if [[ "$is_destructive" == "false" ]]; then
    exit 0
fi

# Special cases that are always blocked regardless of target
if matches -E "rm[[:space:]]+-[^[:space:]]*[rf].*[[:space:]]/$|rm[[:space:]]+-[^[:space:]]*[rf].*[[:space:]]/[[:space:]]*$" "$COMMAND"; then
    echo "DevOPs RM BLOCK: 'rm -rf /' or equivalent. Absolutely not." >&2
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
    # Into NORMALISED, not printed: a $( ) per path forks once per word of a long command.
    printf -v NORMALISED '/%s' "${out[*]-}"
}
inside() { [[ "$1" == "$2" || "$1" == "$2/"* ]]; }

# Extract target paths from rm commands
# This is heuristic — extract everything that looks like a path argument
targets=$(echo "$COMMAND" | grep -oE '(/?[a-zA-Z0-9_./\-]+)' | grep -v '^-' || true)

# The command's log text is escaped once, on the first in-project target, not once per target.
# The hook runner blocks a hook that runs out of its time budget, so a slow decision cannot pass.
command_log=""
set -f
for target in $targets; do
    # Resolve to a normalised absolute path
    if [[ "$target" == /* ]]; then
        normalise "$target"; abs_target="$NORMALISED"
    else
        normalise "$PROJECT_ROOT/$target"; abs_target="$NORMALISED"
    fi

    # Skip obvious non-paths
    # One-character words are not paths, except . and / themselves: / is the root.
    if [[ "$target" == "rm" || "$target" == "find" || ( ${#target} -lt 2 && "$target" != "." && "$target" != "/" ) ]]; then
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
        [[ -n "$command_log" ]] || command_log="$(log_text "$COMMAND")"
        [[ -n "${log_ts:-}" ]] || log_ts="$(date -u +%s)"
        echo "{\"ts\":$log_ts,\"event\":\"destructive_in_project\",\"target\":\"$(log_text "$abs_target")\",\"command\":\"$command_log\"}" >> .workflow/state/events.jsonl
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
        echo "{\"ts\":$(date -u +%s),\"event\":\"rm_blocked\",\"target\":\"$(log_text "$abs_target")\"}" >> .workflow/state/events.jsonl
        exit 2
    fi
done

exit 0
