#!/usr/bin/env bash
# hooks/universal/session-start/load-baton.sh
#
# Fires on session start. Loads the baton if present and recent, then prints
# a status banner the agent reads.
#
# This implements Principle 6 (Surgical Honesty Across Tool Handoffs).

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
        echo "    → Read its '## Next action' section first"
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
    echo "ℹ  No project profile. Run 'devops analyze' to detect stack and recommend config."
    echo ""
fi

# ─── Check client profile ───────────────────────────────────────────────────
CLIENT_PROFILE=".workflow/client/profile.yml"
if [[ -f "$CLIENT_PROFILE" ]]; then
    client_name=$(grep "^name:" "$CLIENT_PROFILE" | head -n1 | awk '{print $2}' || echo "unknown")
    echo "👤 CLIENT: $client_name"
    echo "    → Compliance scope and pentest authorization in $CLIENT_PROFILE"
    echo "    → Stay inside that scope and the project root; cross-client"
    echo "      operations are forbidden. hooks/universal/pre-tool/client-boundary.sh"
    echo "      blocks paths outside the root only where the host tool wires it."
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
# Session id and tool are caller-supplied text, so both are escaped (issue #426).
printf '{"ts":%s,"event":"session_start","session_id":"%s","tool":"%s"}\n' \
    "$(date -u +%s)" "$(json_escape "$session_id")" "$(json_escape "${DEVOPS_TOOL:-unknown}")" >> .workflow/state/events.jsonl

echo "═══════════════════════════════════════════════════════════════════"
echo ""

exit 0
