#!/usr/bin/env bash
# hooks/universal/pre-tool/budget-brake.sh
#
# Hard USD budget brake. Fires before every LLM call.
# Implements the reserve-commit pattern: reserve max possible cost, commit
# actual cost after the call completes.
#
# This hook CANNOT be overridden by the agent. If the cap is hit, the session
# halts and the user must intervene.
#
# Example this guards against: an overnight agent run reported to cost $437
# (an unverified anecdote; source in cost-controls/README.md).

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
BUDGET_CONFIG="${DEVOPS_BUDGET_CONFIG:-.workflow/state/budget.yml}"
LEDGER="${DEVOPS_BUDGET_LEDGER:-.workflow/state/budget-ledger.jsonl}"
SESSION_ID="${DEVOPS_SESSION_ID:-unknown}"

# Defaults (overridden by config file if present)
DEFAULT_SESSION_CAP_USD="5.00"
DEFAULT_HOURLY_CAP_USD="20.00"
DEFAULT_DAILY_CAP_USD="100.00"

# ─── Read configured caps ───────────────────────────────────────────────────
if [[ -f "$BUDGET_CONFIG" ]]; then
    # Simple YAML parser for the three fields we care about
    SESSION_CAP=$(grep -E "^session_cap_usd:" "$BUDGET_CONFIG" 2>/dev/null | awk '{print $2}' || echo "$DEFAULT_SESSION_CAP_USD")
    HOURLY_CAP=$(grep -E "^hourly_cap_usd:" "$BUDGET_CONFIG" 2>/dev/null | awk '{print $2}' || echo "$DEFAULT_HOURLY_CAP_USD")
    DAILY_CAP=$(grep -E "^daily_cap_usd:" "$BUDGET_CONFIG" 2>/dev/null | awk '{print $2}' || echo "$DEFAULT_DAILY_CAP_USD")
else
    SESSION_CAP="$DEFAULT_SESSION_CAP_USD"
    HOURLY_CAP="$DEFAULT_HOURLY_CAP_USD"
    DAILY_CAP="$DEFAULT_DAILY_CAP_USD"
fi

# ─── Compute running totals from ledger ─────────────────────────────────────
# Each total reads the ledger in one awk program, so a ledger with no matching
# line sums to 0 instead of failing a grep stage under pipefail (#356). The
# session id is compared as text from the environment, never as a pattern. An
# unreadable ledger fails the function, and the caller blocks the call.
session_total() {
    if [[ ! -f "$LEDGER" ]]; then echo "0.0000"; return; fi
    BRAKE_SESSION="$SESSION_ID" awk '
        index($0, "\"session_id\":\"" ENVIRON["BRAKE_SESSION"] "\"") {
            if (match($0, /"cost_usd":[0-9.]+/)) sum += substr($0, RSTART+11, RLENGTH-11) }
        END { printf "%.4f", sum+0 }
    ' "$LEDGER"
}

window_total() {
    if [[ ! -f "$LEDGER" ]]; then echo "0.0000"; return; fi
    awk -F'"ts":' -v cutoff="$1" '
        { match($2, /[0-9]+/); ts = substr($2, RSTART, RLENGTH);
          if (ts >= cutoff) { match($0, /"cost_usd":[0-9.]+/); cost = substr($0, RSTART+11, RLENGTH-11); sum += cost } }
        END { printf "%.4f", sum+0 }
    ' "$LEDGER"
}

hourly_total() {
    window_total "$(date -u -d '1 hour ago' +%s 2>/dev/null || date -u -v-1H +%s)"
}

daily_total() {
    window_total "$(date -u -d '1 day ago' +%s 2>/dev/null || date -u -v-1d +%s)"
}

# ─── Reserve check ──────────────────────────────────────────────────────────
# The next call's max possible cost is passed as $1 (in USD).
# If not provided, conservatively assume $0.10 (1 standard Opus call).
RESERVE="${1:-0.10}"

# Every amount is a plain non-negative decimal. A negative reserve would lower the
# projected total, and any other text would be read by awk as program code, so an
# amount this hook cannot read blocks the call.
decimal() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; }
for amount in "reserve:$RESERVE" "session_cap_usd:$SESSION_CAP" "hourly_cap_usd:$HOURLY_CAP" "daily_cap_usd:$DAILY_CAP"; do
    if ! decimal "${amount#*:}"; then
        echo "DevOPs BUDGET BRAKE: ${amount%%:*} '${amount#*:}' is not a non-negative decimal amount. Blocked." >&2
        exit 2
    fi
done

# A ledger path that exists but is not a regular file (a directory, a dangling
# link) would count as no spend, and the reservation could not be appended.
if [[ ( -e "$LEDGER" || -L "$LEDGER" ) && ! -f "$LEDGER" ]]; then
    echo "DevOPs BUDGET BRAKE: $LEDGER is not a regular file. Blocked." >&2
    exit 2
fi

# A ledger cost that is not a plain non-negative decimal (negative, text, empty)
# would be summed as 0 or lower the total, so a ledger holding one blocks.
# One awk program, not a grep pipeline: under pipefail an early `grep -q` exit
# would kill the first grep with SIGPIPE on a large ledger and let the call through.
if [[ -f "$LEDGER" ]] && awk '/"cost_usd"/ && !/"cost_usd":[0-9]+(\.[0-9]+)?[,}]/ { bad = 1; exit } END { exit !bad }' "$LEDGER"; then
    echo "DevOPs BUDGET BRAKE: $LEDGER holds a cost_usd that is not a non-negative decimal amount. Blocked." >&2
    exit 2
fi

unreadable() {
    echo "DevOPs BUDGET BRAKE: cannot read $LEDGER to total the spend. Blocked." >&2
    exit 2
}
session_now=$(session_total) || unreadable
hourly_now=$(hourly_total) || unreadable
daily_now=$(daily_total) || unreadable

projected_session=$(awk -v a="$session_now" -v b="$RESERVE" 'BEGIN {printf "%.4f", a + b}')
projected_hourly=$(awk -v a="$hourly_now" -v b="$RESERVE" 'BEGIN {printf "%.4f", a + b}')
projected_daily=$(awk -v a="$daily_now" -v b="$RESERVE" 'BEGIN {printf "%.4f", a + b}')

# ─── Enforce ────────────────────────────────────────────────────────────────
exceeded() {
    awk -v a="$1" -v b="$2" 'BEGIN {exit !(a + 0 > b + 0)}'
}

if exceeded "$projected_session" "$SESSION_CAP"; then
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs BUDGET BRAKE — SESSION CAP EXCEEDED                       ║
╠═══════════════════════════════════════════════════════════════════╣
║  Session cap:        \$$SESSION_CAP
║  Spent so far:       \$$session_now
║  Reserve requested:  \$$RESERVE
║  Projected total:    \$$projected_session
║                                                                   ║
║  This session is halted: the cap protects the user from runaway   ║
║  agent costs. Stop and tell the user. Raising the cap in          ║
║  .workflow/state/budget.yml is the user's decision, not yours, so ║
║  do not edit that file. If the work should continue in a later    ║
║  session, write the baton first (/checkpoint, defined in          ║
║  slash-commands/universal/checkpoint.md).                         ║
╚═══════════════════════════════════════════════════════════════════╝
EOF
    exit 2
fi

if exceeded "$projected_hourly" "$HOURLY_CAP"; then
    echo "DevOPs BUDGET BRAKE: hourly cap exceeded (\$$projected_hourly > \$$HOURLY_CAP). Session halted." >&2
    exit 2
fi

if exceeded "$projected_daily" "$DAILY_CAP"; then
    echo "DevOPs BUDGET BRAKE: daily cap exceeded (\$$projected_daily > \$$DAILY_CAP). Sessions paused until tomorrow." >&2
    exit 2
fi

# ─── Write reservation to ledger (commit pattern) ───────────────────────────
mkdir -p "$(dirname "$LEDGER")"
ts=$(date -u +%s)
echo "{\"ts\":$ts,\"session_id\":\"$SESSION_ID\",\"type\":\"reserve\",\"cost_usd\":$RESERVE}" >> "$LEDGER"

exit 0
