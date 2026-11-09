#!/usr/bin/env bash
# hooks/universal/pre-tool/block-secrets-bash.sh: block-secrets.sh for a Bash command (issue #426, AC-30).
# run-hook.mjs passes the command as $1. The command is split into words the way a shell would
# split it: quotes are respected and stripped, a backslash escapes the next character, a
# backslash-newline is removed, and unquoted whitespace and ; | & < > ( ) ` separate words. Each word
# is checked by secret_check from block-secrets.sh, beside this file (sourced, so a long command does
# not start one process per word), with operation `run`. Any result other than 0 blocks with exit 2.
#
# A word that still contains whitespace is a quoted message, not a path, and is skipped, unless it
# holds a command substitution ($( or a backtick): then each piece of it is checked. A command with a
# quote left open is also checked with every quote and backslash removed, so a stray quote cannot
# hide a path. If awk is missing or fails, the hook blocks.
#
# A convenience guard, not a security boundary. It reads the command text only and runs nothing from
# it, so it does not catch `cat $(echo .e)nv`, a path held in a variable, a glob such as `cat .en?`,
# or a secret read by a script, by an interpreter given the command as a string, or by a program
# that opens the file itself. docs/HOOKS.md lists what it does not catch.

CMD="${1:-}"
# No dirname: the directory comes from $0 itself, so the only programs this hook needs are awk and tr.
case "$0" in */*) HERE="${0%/*}" ;; *) HERE=. ;; esac
# shellcheck source=block-secrets.sh
source "$HERE/block-secrets.sh" || exit 2
set +e

fail_closed() { echo "DevOPs SECRET BLOCK: $1 -- failing closed" >&2; exit 2; }
command -v awk >/dev/null 2>&1 || fail_closed "awk is not on PATH, so the command cannot be checked"

# Checks one word. Only a word that could match a pattern reaches secret_check: every entry in
# block-secrets.sh's PATTERNS and EXT_BLOCK holds a . or a /, or is an id_* key or service-account
# (tests/hooks/block-secrets-bash.test.mjs keeps the lists and this filter in step).
check_word() {
    local w="$1"
    [[ -z "$w" ]] && return 0
    case "$w" in
        *[./]*|*[Ii][Dd]_*|*[Ss][Ee][Rr][Vv][Ii][Cc][Ee]-[Aa][Cc][Cc][Oo][Uu][Nn][Tt]*) ;;
        *) return 0 ;;
    esac
    secret_check "$w" run || exit 2
}

# Checks the pieces of $1 with every quote and backslash removed, split on whitespace and every
# separator. Used for a quoted string that holds a command substitution, where the quotes inside the
# substitution belong to another shell level, and for a command with a quote left open.
check_pieces() {
    local piece
    while IFS= read -r piece; do check_word "$piece"; done < <(printf '%s\n' "$1" | LC_ALL=C tr -d "'\"\\\\" | LC_ALL=C tr ' \t\r\n;|&<>()`$' '\n\n\n\n\n\n\n\n\n\n\n\n')
}

# One awk pass, byte by byte (LC_ALL=C): a bash character loop is quadratic on a long command.
# Prints "W<word>" for each word that could matter (see flush), then, at the end, "S0" when every
# quote closed or "S1" when one was left open. awk reads the command line by line, but the quote
# state and the word carry over from line to line, so the command is one state machine and no byte
# in it starts a fresh one. A newline inside quotes becomes a space, so a quoted word stays on one
# output line. The W prefix means no command text can pose as the status line.
SPLIT="$(printf '%s' "$CMD" | LC_ALL=C awk '
    BEGIN { bs = sprintf("%c", 92); sq = sprintf("%c", 39); dq = sprintf("%c", 34); bt = sprintf("%c", 96); w = ""; q = "" }
    # Prints only a word that could matter: one with whitespace (bash decides on it) or one that
    # passes the same filter as check_word, so a long command does not send every word to bash.
    function flush() { if (w != "" && (w ~ /[ \t\r\n]/ || tolower(w) ~ /[.\/]|id_|service-account/)) print "W" w; w = "" }
    {
        # The newline awk took off the line is put back, so a backslash before it is a
        # backslash-newline and every line still ends in a separator. A newline added after the last
        # line is harmless: it only ends the last word.
        # split(s, ch, "") gives one byte per element in one pass; the BSD awk substr is linear per
        # call, so a substr loop is quadratic. An awk whose split does not split into characters
        # (POSIX leaves the empty separator open) gets the substr loop instead.
        s = $0 "\n"; n = length(s)
        bychar = (split(s, ch, "") == n)
        for (i = 1; i <= n; i++) {
            c = bychar ? ch[i] : substr(s, i, 1)
            if (q == sq) { if (c == sq) q = ""; else w = w (c == "\n" ? " " : c); continue }
            if (q == dq) {
                if (c == dq) { q = "" }
                else if (c == bs && i < n) {
                    nx = bychar ? ch[i + 1] : substr(s, i + 1, 1)
                    if (nx == "\n") { i++ }
                    else if (nx == dq || nx == bs || nx == "$" || nx == bt) { w = w nx; i++ }
                    else { w = w c }
                }
                else { w = w (c == "\n" ? " " : c) }
                continue
            }
            if (c == sq || c == dq) { q = c }
            else if (c == bs) { if (i < n) { i++; nx = bychar ? ch[i] : substr(s, i, 1); if (nx != "\n") w = w nx } }
            else if (c == " " || c == "\t" || c == "\n" || c == ";" || c == "|" || c == "&" || c == "<" || c == ">" || c == "(" || c == ")" || c == bt) { flush() }
            else { w = w c }
        }
    }
    END { flush(); print (q == "" ? "S0" : "S1") }')" || fail_closed "awk could not split the command"

status=""
while IFS= read -r line; do
    case "$line" in
        W*)
            w="${line#W}"
            if [[ "$w" == *[[:space:]]* ]]; then
                # A quoted message is skipped, but not a command substitution inside one.
                if [[ "$w" == *'$('* || "$w" == *'`'* ]]; then check_pieces "$w"; fi
            else
                check_word "$w"
            fi
            ;;
        S0|S1) status="$line" ;;
    esac
done <<< "$SPLIT"

[[ -n "$status" ]] || fail_closed "awk gave no result for the command"
# A quote left open: also check the text with every quote and backslash removed, split on everything.
if [[ "$status" == S1 ]]; then
    check_pieces "$(printf '%s' "$CMD" | LC_ALL=C tr -d "'\"\\\\")"
fi

exit 0
