#!/usr/bin/env bash
# hooks/universal/pre-tool/client-boundary.sh
#
# Enforces client data isolation: the agent may not read or write outside
# the current project root, unless the path is in an explicit allowlist.
#
# Required for multi-tenant work where one developer handles multiple
# clients. Prevents accidental cross-client data exposure.
#
# Input: the PreToolUse JSON on stdin (tool_input.file_path, .path or
# .notebook_path), or, when stdin is empty or a terminal, argv:
# client-boundary.sh <path> [read|write|access].
# Every failure exits 2 (block); exit 1 is non-blocking in Claude Code.
# Requires bash 3.2+ and node. Nothing from the input or the allowlist is
# ever evaluated.

set -euo pipefail
# Any unexpected failure under set -e would exit 1, which Claude Code treats as
# non-blocking. Turn every non-zero exit into a block.
trap 'rc=$?; [[ $rc -eq 0 ]] || exit 2' EXIT

fail() {
    printf 'DevOPs CLIENT BOUNDARY BLOCK: %s\n' "$1" >&2
    exit 2
}

HOME="${HOME:-}"
command -v node >/dev/null 2>&1 || fail 'node missing -- failing closed'
PROJECT_ROOT="$(pwd -P)" || fail 'cannot resolve the project root'

# --- Input ---------------------------------------------------------------
PAYLOAD=""
if [[ ! -t 0 ]]; then
    PAYLOAD="$(cat)" || PAYLOAD=""
fi

if [[ -n "$PAYLOAD" ]]; then
    rc=0
    out="$(printf '%s' "$PAYLOAD" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { s += c; });
process.stdin.on("end", () => {
  let d;
  try { d = JSON.parse(s); } catch { process.exit(2); }
  if (d === null || typeof d !== "object" || Array.isArray(d)) process.exit(2);
  const ti = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};
  // Every present path field is checked, not just the first.
  const ps = [ti.file_path, ti.path, ti.notebook_path].filter((v) => typeof v === "string" && v !== "");
  if (ps.length === 0) process.exit(4);
  if (ps.some((v) => v.includes("\u0001") || v.includes("\0"))) process.exit(2);
  const n = typeof d.tool_name === "string" ? d.tool_name : "";
  const op = /^(Read|Glob|Grep|LS|NotebookRead)$/.test(n) ? "r" : /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(n) ? "w" : "a";
  process.stdout.write(op + ps.map((v) => "\u0001" + v).join(""));
});
' && printf x)" || rc=$?
    case "$rc" in
        0) ;;
        4) exit 0 ;;
        *) fail 'stdin is not a PreToolUse JSON object' ;;
    esac
    out="${out%x}"
    case "${out:0:1}" in
        r) OPERATION="read" ;;
        w) OPERATION="write" ;;
        *) OPERATION="access" ;;
    esac
    # Paths are separated by \001; the node step rejects a path containing it.
    PATHS=()
    rest="${out:1}"
    while [[ -n "$rest" ]]; do
        rest="${rest#$'\001'}"
        PATHS+=("${rest%%$'\001'*}")
        case "$rest" in
            *$'\001'*) rest=$'\001'"${rest#*$'\001'}" ;;
            *) rest="" ;;
        esac
    done
else
    PATH_ARG="${1:-}"
    OPERATION="${2:-access}"
    [[ -n "$PATH_ARG" ]] || exit 0
    PATHS=("$PATH_ARG")
fi

# A leading ~ means HOME to the file tools (not to a directory named "~" under
# the project root). ~user is not resolved: blocked. Result in $EXPANDED.
expand_tilde() {
    EXPANDED="$1"
    # shellcheck disable=SC2088
    case "$1" in
        '~' | '~/'*)
            [[ -n "$HOME" && "$HOME" == /* ]] || fail 'path starts with ~ but HOME is not set to an absolute path'
            EXPANDED="$HOME${1#'~'}" ;;
        '~'*) fail 'paths starting with ~user are not resolved -- blocked' ;;
    esac
}

# --- Path normalisation --------------------------------------------------
# Lexical clean-up of an absolute path: drops "." and empty segments and
# resolves "..". Result in $LEX (not via $(...), which would strip a
# trailing newline from the path). No globbing, no word splitting.
lexical() {
    local rest="${1#/}" out="" seg
    while :; do
        seg="${rest%%/*}"
        case "$seg" in
            '' | .) ;;
            ..) out="${out%/*}" ;;
            *) out="$out/$seg" ;;
        esac
        [[ "$rest" == */* ]] || break
        rest="${rest#*/}"
    done
    LEX="${out:-/}"
}

# Physical first (the kernel resolves symlinks before "..", so
# link/../x is outside when link points outside), then lexical for the
# part that does not exist yet, then follow a leaf symlink. Bounded.
# Result in $NORM.
normalize() {
    local p="$1" hops=0 head tail target
    [[ "$p" == /* ]] || p="$PROJECT_ROOT/$p"
    while (( hops < 40 )); do
        head="$p"
        tail=""
        while [[ "$head" != / && ! -d "$head" ]]; do
            tail="/${head##*/}$tail"
            head="${head%/*}"
            head="${head:-/}"
        done
        head="$(cd -P -- "$head" 2>/dev/null && pwd -P)" || return 1
        lexical "${head%/}$tail"
        p="$LEX"
        [[ -L "$p" ]] || { NORM="$p"; return 0; }
        target="$(readlink -- "$p" && printf x)" || return 1
        target="${target%x}"
        target="${target%$'\n'}"
        [[ "$target" == /* ]] || target="${p%/*}/$target"
        p="$target"
        hops=$((hops + 1))
    done
    return 1
}

# Normalised directory or file entry without a trailing slash, in $NORM.
norm_entry() {
    normalize "$1" || return 1
    [[ "$NORM" == / ]] || NORM="${NORM%/}"
}

# $1 equals $2 or lies below it. Right-hand sides are quoted: no globbing.
within() {
    [[ "$2" == / ]] && return 0
    [[ "$1" == "$2" || "$1" == "$2/"* ]]
}

# Decides one path: returns 0 when allowed, exits 2 when blocked.
check_path() {
    expand_tilde "$1"
    normalize "$EXPANDED" || fail "cannot resolve path"
    abs_path="$NORM"

    # Within project root -> always OK
    if within "$abs_path" "$PROJECT_ROOT"; then
        return 0
    fi

    # Paths always allowed (read-only system resources). Directories end in /;
    # entries are normalised so that /tmp matches /private/tmp on macOS, and
    # file entries match by equality only.
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
    )
    if [[ -n "$HOME" && "$HOME" == /* ]]; then
        ALLOWED_GLOBAL_READ+=(
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
    fi

    if [[ "$OPERATION" == "read" ]]; then
        for allowed in "${ALLOWED_GLOBAL_READ[@]}"; do
            norm_entry "$allowed" || continue
            # Directory entries (trailing /) match by boundary, file entries by equality.
            if [[ "$allowed" == */ ]]; then
                within "$abs_path" "$NORM" && return 0
            else
                [[ "$abs_path" == "$NORM" ]] && return 0
            fi
        done
    fi

    # Per-project allowlist: literal absolute paths. Only a leading ~, $HOME or
    # ${HOME} is expanded; any other $ or backtick makes the line ignored.
    PROJECT_ALLOWLIST="$PROJECT_ROOT/.workflow/client/path-allowlist.txt"
    if [[ -f "$PROJECT_ALLOWLIST" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            line="${line%$'\r'}"
            case "$line" in
                '' | '#'*) continue ;;
            esac
            # Trailing blanks are dropped so that "/path " matches "/path".
            while [[ "$line" == *[[:blank:]] ]]; do line="${line%?}"; done
            # shellcheck disable=SC2016,SC2088
            case "$line" in
                '~' | '~/'* | '$HOME' | '$HOME/'* | '${HOME}' | '${HOME}/'*)
                    if [[ -z "$HOME" || "$HOME" != /* ]]; then
                        printf 'client-boundary: allowlist line ignored (HOME is not set to an absolute path)\n' >&2
                        continue
                    fi ;;
            esac
            case "$line" in
                '~' | '~/'*) line="$HOME${line#'~'}" ;;
                '$HOME' | '$HOME/'*) line="$HOME${line#'$HOME'}" ;;
                '${HOME}' | '${HOME}/'*) line="$HOME${line#'${HOME}'}" ;;
            esac
            case "$line" in
                *'$'* | *'`'*)
                    printf 'client-boundary: allowlist line ignored (unsupported expansion)\n' >&2
                    continue ;;
                /*) ;;
                *)
                    printf 'client-boundary: allowlist line ignored (not an absolute path)\n' >&2
                    continue ;;
            esac
            norm_entry "$line" || continue
            if within "$abs_path" "$NORM"; then
                return 0
            fi
        done < "$PROJECT_ALLOWLIST"
    fi

    # --- Blocked -------------------------------------------------------------
    cat >&2 <<MSG || true
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
MSG

    # Logging is best effort: a failure here must not change the exit code.
    json() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1"; }
    {
        mkdir -p "$PROJECT_ROOT/.workflow/state" &&
            printf '{"ts":%s,"event":"boundary_blocked","path":%s,"operation":%s}\n' \
                "$(date -u +%s)" "$(json "$abs_path")" "$(json "$OPERATION")" \
                >> "$PROJECT_ROOT/.workflow/state/events.jsonl"
    } 2>/dev/null || printf 'client-boundary: could not append the event line\n' >&2 || true

    exit 2
}

for candidate in "${PATHS[@]}"; do
    check_path "$candidate"
done
exit 0
