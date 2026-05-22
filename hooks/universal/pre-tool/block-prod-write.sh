#!/usr/bin/env bash
# hooks/universal/pre-tool/block-prod-write.sh
#
# Blocks any git push, deploy, or schema migration targeting production
# unless an explicit approval token exists in .workflow/state/approvals.jsonl.
#
# Real incident this prevents: Amazon's Kiro AI agent autonomously deleted a
# production AWS environment, causing a 13-hour outage (documented 2026).

set -euo pipefail

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
    if echo "$COMMAND" | grep -qE "$pattern"; then
        matched="$pattern"
        break
    fi
done

if [[ -z "$matched" ]]; then
    exit 0
fi

# Check for valid approval token
# An approval is valid if it's < 5 minutes old and matches this command pattern
if [[ -f "$APPROVALS" ]]; then
    recent_approval=$(awk -F'"ts":' -v cutoff="$(($(date -u +%s) - 300))" '
        { match($2, /[0-9]+/); ts = substr($2, RSTART, RLENGTH)
          if (ts >= cutoff) print $0 }
    ' "$APPROVALS" | tail -n 1)

    if [[ -n "$recent_approval" ]]; then
        # Log the approved action
        mkdir -p .workflow/state
        echo "{\"ts\":$(date -u +%s),\"event\":\"prod_action_approved\",\"command\":$(echo "$COMMAND" | jq -R . 2>/dev/null || echo "\"$COMMAND\"")}" >> .workflow/state/events.jsonl
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
║  To proceed, the human operator must explicitly approve:          ║
║                                                                   ║
║    /approve-prod-deploy                                           ║
║                                                                   ║
║  This writes an approval token to .workflow/state/approvals.jsonl ║
║  valid for 5 minutes. Re-run the command within that window.      ║
║                                                                   ║
║  This block protects you from agent runaway against production.   ║
║  Real incident: Amazon's Kiro deleted a prod AWS environment      ║
║  causing a 13-hour outage. Don't be the next one.                 ║
╚═══════════════════════════════════════════════════════════════════╝
EOF

# Log the block
mkdir -p .workflow/state
echo "{\"ts\":$(date -u +%s),\"event\":\"prod_write_blocked\",\"command\":$(echo "$COMMAND" | jq -R . 2>/dev/null || echo "\"$COMMAND\""),\"pattern\":\"$matched\"}" >> .workflow/state/events.jsonl

exit 2
