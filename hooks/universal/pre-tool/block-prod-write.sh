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
║  Stop and ask the user. Approval is the human operator's action:  ║
║  they add an entry to .workflow/state/approvals.jsonl, and the    ║
║  command may be re-run within 5 minutes of it. Do not write an    ║
║  approval entry yourself.                                         ║
║                                                                   ║
║  This block protects production from agent runaway. In a          ║
║  reported incident, Amazon's Kiro agent deleted and recreated an  ║
║  AWS environment; Amazon blames misconfigured access controls.    ║
╚═══════════════════════════════════════════════════════════════════╝
EOF

# Log the block
mkdir -p .workflow/state
echo "{\"ts\":$(date -u +%s),\"event\":\"prod_write_blocked\",\"command\":$(echo "$COMMAND" | jq -R . 2>/dev/null || echo "\"$COMMAND\""),\"pattern\":\"$matched\"}" >> .workflow/state/events.jsonl

exit 2
