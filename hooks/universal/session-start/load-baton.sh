#!/usr/bin/env bash
# hooks/universal/session-start/load-baton.sh
#
# Fires on session start. Loads the baton if present and recent, then prints
# a status banner the agent reads.
#
# This implements Principle 6 (Surgical Honesty Across Tool Handoffs).

set -euo pipefail

BATON="${DEVOPS_BATON:-.workflow/state/baton.md}"
PROFILE="${DEVOPS_PROFILE:-.workflow/profile.yml}"
MAX_AGE_HOURS=24

mkdir -p .workflow/state

# ─── Print constitution reminder ────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  DevOPs SESSION START — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "FIRST ACTIONS (mandatory):"
echo "  1. Read constitution/PRINCIPLES.md"
echo "  2. Read constitution/ANTIPATTERNS.md"
echo "  3. Read constitution/LOOP.md"
echo ""

# ─── Check baton ────────────────────────────────────────────────────────────
if [[ -f "$BATON" ]]; then
    baton_mtime=$(stat -c %Y "$BATON" 2>/dev/null || stat -f %m "$BATON" 2>/dev/null || echo 0)
    now=$(date -u +%s)
    age_seconds=$((now - baton_mtime))
    age_hours=$((age_seconds / 3600))

    if (( age_hours <= MAX_AGE_HOURS )); then
        echo "📋 BATON FOUND (age: ${age_hours}h, max: ${MAX_AGE_HOURS}h)"
        echo "    → Resume from .workflow/state/baton.md"
        echo "    → Read 'next_action' section first"
        echo ""
    else
        echo "⚠  Baton found but stale (age: ${age_hours}h > ${MAX_AGE_HOURS}h)"
        echo "    → Treat as informational only. Start fresh from /specs/"
        echo ""
    fi
else
    echo "ℹ  No baton found. Starting fresh."
    echo "    → Read /specs/ to understand current scope"
    echo ""
fi

# ─── Check project profile ──────────────────────────────────────────────────
if [[ -f "$PROFILE" ]]; then
    # Check if a manifest file is newer than the profile
    manifest_files=(package.json Cargo.toml pyproject.toml go.mod Gemfile)
    profile_mtime=$(stat -c %Y "$PROFILE" 2>/dev/null || stat -f %m "$PROFILE" 2>/dev/null || echo 0)

    for manifest in "${manifest_files[@]}"; do
        if [[ -f "$manifest" ]]; then
            manifest_mtime=$(stat -c %Y "$manifest" 2>/dev/null || stat -f %m "$manifest" 2>/dev/null || echo 0)
            if (( manifest_mtime > profile_mtime )); then
                echo "⚠  $manifest is newer than .workflow/profile.yml"
                echo "    → Run analyzer/scan.ts to update the profile"
                echo ""
                break
            fi
        fi
    done
else
    echo "ℹ  No project profile. Run scripts/analyze.sh to detect stack and recommend config."
    echo ""
fi

# ─── Check client profile ───────────────────────────────────────────────────
CLIENT_PROFILE=".workflow/client/profile.yml"
if [[ -f "$CLIENT_PROFILE" ]]; then
    client_name=$(grep "^name:" "$CLIENT_PROFILE" | head -n1 | awk '{print $2}' || echo "unknown")
    echo "👤 CLIENT: $client_name"
    echo "    → Compliance scope and pentest authorization in $CLIENT_PROFILE"
    echo "    → Stay within scope. Cross-client operations are blocked."
    echo ""
fi

# ─── Check for unresolved blockers ──────────────────────────────────────────
BLOCKERS=".workflow/state/blockers.md"
if [[ -f "$BLOCKERS" ]]; then
    open_blockers=$(grep -c "^## Blocker" "$BLOCKERS" 2>/dev/null || echo 0)
    if (( open_blockers > 0 )); then
        echo "🚧 OPEN BLOCKERS: $open_blockers"
        echo "    → Read $BLOCKERS"
        echo "    → Resolve before starting new work"
        echo ""
    fi
fi

# ─── Check budget status ────────────────────────────────────────────────────
BUDGET_LEDGER=".workflow/state/budget-ledger.jsonl"
if [[ -f "$BUDGET_LEDGER" ]]; then
    today_cost=$(awk -F'"cost_usd":' -v cutoff="$(($(date -u +%s) - 86400))" '
        { match($2, /[0-9.]+/); cost = substr($2, RSTART, RLENGTH); sum += cost }
        END { printf "%.2f", sum+0 }
    ' "$BUDGET_LEDGER" 2>/dev/null || echo "0.00")
    echo "💰 Spend last 24h: \$$today_cost"
    echo ""
fi

# ─── Log session start ──────────────────────────────────────────────────────
session_id="${DEVOPS_SESSION_ID:-$(date -u +%s)-$(echo $$)}"
echo "{\"ts\":$(date -u +%s),\"event\":\"session_start\",\"session_id\":\"$session_id\",\"tool\":\"${DEVOPS_TOOL:-unknown}\"}" >> .workflow/state/events.jsonl

echo "═══════════════════════════════════════════════════════════════════"
echo ""

exit 0
