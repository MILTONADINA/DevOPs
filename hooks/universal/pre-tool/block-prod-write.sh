#!/usr/bin/env bash
# hooks/universal/pre-tool/block-prod-write.sh
#
# Blocks any git push, deploy, or schema migration targeting production
# unless an explicit approval token exists in .workflow/state/approvals.jsonl.
#
# Incident this guards against: Amazon's Kiro agent reportedly deleted and
# recreated an AWS Cost Explorer environment, a ~13h outage in one region
# (FT, Feb 2026; Amazon attributes it to misconfigured access controls).

set -euo pipefail

# Escapes $1 for use inside a JSON string literal: backslash, quote, and control characters
# (RFC 8259). A character loop, not ${var//pat/rep}: bash 3.2 (macOS /bin/bash) mangles quoted
# replacements. Bytes 0x80 and above pass through unchanged, as UTF-8 (bash 3.2 reports them as
# negative codes, hence the code >= 0 guard).
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

COMMAND="${1:-}"
APPROVALS="${DEVOPS_APPROVALS:-.workflow/state/approvals.jsonl}"

# Patterns that indicate production-affecting commands
PROD_PATTERNS=(
    "git push.*origin (main|master|production|release/)"
    "git push.*--force"
    "git push.*-f "
    "kubectl.*apply.*(prod|production)"
    "terraform apply"
    "pulumi up"
    "aws.*delete-"
    "aws s3 rm.*s3://(prod|production)"
    "psql.*production"
    "mysql.*production"
    "DROP DATABASE"
    "DROP TABLE"
    "DELETE FROM"
    "TRUNCATE"
    "alembic upgrade head"
    "prisma migrate deploy"
    "rails db:migrate.*production"
    "django.*migrate"
    "supabase db push"
    "vercel.*--prod"
    "netlify deploy.*--prod"
    "flyctl deploy"
    "railway up"
)

# Check if command matches any production pattern
matched=""
for pattern in "${PROD_PATTERNS[@]}"; do
    # Case-insensitive: SQL keywords and CLI names are often typed in either case.
    if echo "$COMMAND" | grep -qiE "$pattern"; then
        matched="$pattern"
        break
    fi
done

if [[ -z "$matched" ]]; then
    exit 0
fi

# Check for valid approval token
# An approval is valid if it's < 5 minutes old and matches this command pattern
# An approval is one JSON line whose numeric "ts" is from the last 5 minutes (not
# the future) and whose "command" is exactly this command, so one approval cannot
# unlock a different production command. Lines that are not JSON are ignored, and
# without jq nothing is approved.
if [[ -f "$APPROVALS" ]]; then
    now="$(date -u +%s)"
    if jq -nRe --arg command "$COMMAND" --argjson now "$now" '
        [inputs | fromjson? | objects
         | select((.ts | type) == "number" and .ts >= ($now - 300) and .ts <= $now
                  and .command == $command)]
        | length > 0' < "$APPROVALS" > /dev/null 2>&1; then
        mkdir -p .workflow/state
        # The command is escaped by json_escape, not jq: jq -R reads per line (a newline splits the
        # value into two JSON strings), and the fallback used to pass the text through unescaped (#426).
        printf '{"ts":%s,"event":"prod_action_approved","command":"%s"}\n' "$now" "$(json_escape "$COMMAND")" >> .workflow/state/events.jsonl
        exit 0
    fi
fi

cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs PRODUCTION WRITE BLOCK                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Matched pattern: $matched
║                                                                   ║
║  This command would affect production resources. It has been      ║
║  BLOCKED because no recent human approval token exists.           ║
║                                                                   ║
║  Stop and ask the user. Approval is the human operator's action:  ║
║  they add {"ts":<unix seconds>,"command":"<this exact command>"}  ║
║  to .workflow/state/approvals.jsonl, and this command may be      ║
║  re-run within 5 minutes of it. Do not write an approval entry    ║
║  yourself.                                                        ║
║                                                                   ║
║  This block protects production from agent runaway. In a          ║
║  reported incident, Amazon's Kiro agent deleted and recreated an  ║
║  AWS environment; Amazon blames misconfigured access controls.    ║
╚═══════════════════════════════════════════════════════════════════╝
EOF

# Log the block
mkdir -p .workflow/state
printf '{"ts":%s,"event":"prod_write_blocked","command":"%s","pattern":"%s"}\n' \
    "$(date -u +%s)" "$(json_escape "$COMMAND")" "$(json_escape "$matched")" >> .workflow/state/events.jsonl

exit 2
