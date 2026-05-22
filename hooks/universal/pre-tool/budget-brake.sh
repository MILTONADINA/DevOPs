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
# Real incident this prevents: "$437 burned overnight in a single session"
# (documented in 591-incident AI failure-mode catalog 2023-2026).

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
session_total() {
    if [[ ! -f "$LEDGER" ]]; then echo "0.00"; return; fi
    grep "\"session_id\":\"$SESSION_ID\"" "$LEDGER" 2>/dev/null | \
        awk -F'"cost_usd":' '{print $2}' | awk -F',' '{sum += $1} END {printf "%.4f", sum+0}'
}

hourly_total() {
    if [[ ! -f "$LEDGER" ]]; then echo "0.00"; return; fi
    local one_hour_ago=$(date -u -d '1 hour ago' +%s 2>/dev/null || date -u -v-1H +%s)
    awk -F'"ts":' -v cutoff="$one_hour_ago" '
        { match($2, /[0-9]+/); ts = substr($2, RSTART, RLENGTH);
          if (ts >= cutoff) { match($0, /"cost_usd":[0-9.]+/); cost = substr($0, RSTART+11, RLENGTH-11); sum += cost } }
        END { printf "%.4f", sum+0 }
    ' "$LEDGER" 2>/dev/null || echo "0.00"
}

daily_total() {
    if [[ ! -f "$LEDGER" ]]; then echo "0.00"; return; fi
    local one_day_ago=$(date -u -d '1 day ago' +%s 2>/dev/null || date -u -v-1d +%s)
    awk -F'"ts":' -v cutoff="$one_day_ago" '
        { match($2, /[0-9]+/); ts = substr($2, RSTART, RLENGTH);
          if (ts >= cutoff) { match($0, /"cost_usd":[0-9.]+/); cost = substr($0, RSTART+11, RLENGTH-11); sum += cost } }
        END { printf "%.4f", sum+0 }
    ' "$LEDGER" 2>/dev/null || echo "0.00"
}

# ─── Reserve check ──────────────────────────────────────────────────────────
# The next call's max possible cost is passed as $1 (in USD).
# If not provided, conservatively assume $0.10 (1 standard Opus call).
RESERVE="${1:-0.10}"

session_now=$(session_total)
hourly_now=$(hourly_total)
daily_now=$(daily_total)

projected_session=$(awk "BEGIN {printf \"%.4f\", $session_now + $RESERVE}")
projected_hourly=$(awk "BEGIN {printf \"%.4f\", $hourly_now + $RESERVE}")
projected_daily=$(awk "BEGIN {printf \"%.4f\", $daily_now + $RESERVE}")

# ─── Enforce ────────────────────────────────────────────────────────────────
exceeded() {
    awk "BEGIN {exit !($1 > $2)}"
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
║  This session is HALTED. The cap protects you from runaway        ║
║  agent costs. To proceed:                                         ║
║                                                                   ║
║    1. Review .workflow/state/budget-ledger.jsonl                  ║
║    2. If the work justifies it, raise the cap in                  ║
║       .workflow/state/budget.yml                                  ║
║    3. Restart the session                                         ║
║                                                                   ║
║  Or run /checkpoint to write a baton and resume in a new session. ║
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
