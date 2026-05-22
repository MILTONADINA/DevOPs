#!/usr/bin/env bash
# hooks/universal/pre-tool/loop-detection.sh
#
# Detects tool-call loops by tracking (tool_name, args_hash) tuples across
# the session. If the same tuple appears more than THRESHOLD times, halt.
#
# Real incidents this prevents:
#   - 14,000 list_files calls in one Magicrails session
#   - Claude Code subagent burning 27M tokens in a 4.6h infinite loop
#
# "You cannot ask an agent if it is in a loop; you must prove it mathematically."

set -euo pipefail

THRESHOLD="${DEVOPS_LOOP_THRESHOLD:-5}"
WINDOW_MINUTES="${DEVOPS_LOOP_WINDOW_MINUTES:-10}"
TRACKING_FILE="${DEVOPS_LOOP_TRACKING:-.workflow/state/tool-call-tracking.jsonl}"
SESSION_ID="${DEVOPS_SESSION_ID:-unknown}"

# Inputs (passed by the hook caller)
TOOL_NAME="${1:-}"
TOOL_ARGS="${2:-}"

if [[ -z "$TOOL_NAME" ]]; then
    echo "loop-detection.sh: tool name required" >&2
    exit 1
fi

# Compute args hash (deterministic)
if command -v sha256sum >/dev/null 2>&1; then
    ARGS_HASH=$(echo -n "$TOOL_ARGS" | sha256sum | awk '{print $1}' | cut -c1-16)
else
    # macOS fallback
    ARGS_HASH=$(echo -n "$TOOL_ARGS" | shasum -a 256 | awk '{print $1}' | cut -c1-16)
fi

CALL_KEY="${TOOL_NAME}::${ARGS_HASH}"
TS=$(date -u +%s)
WINDOW_START=$((TS - WINDOW_MINUTES * 60))

# Count occurrences of this exact (tool, args) within the window
mkdir -p "$(dirname "$TRACKING_FILE")"
touch "$TRACKING_FILE"

count=$(awk -F'"ts":' -v key="$CALL_KEY" -v cutoff="$WINDOW_START" -v sid="$SESSION_ID" '
    {
        if ($0 ~ "\"session_id\":\"" sid "\"" && $0 ~ "\"call_key\":\"" key "\"") {
            match($2, /[0-9]+/); ts = substr($2, RSTART, RLENGTH)
            if (ts >= cutoff) n++
        }
    }
    END { print n+0 }
' "$TRACKING_FILE")

# Also check for scratchpad stasis: if the last N entries are all the SAME
# call, the agent is definitely stuck
STASIS_LIMIT=3
recent_same=$(tail -n "$STASIS_LIMIT" "$TRACKING_FILE" 2>/dev/null | \
    awk -F'"call_key":"' -v key="$CALL_KEY" '
        { match($2, /"[^"]+"/); k = substr($2, RSTART+1, RLENGTH-2); if (k == key) n++ }
        END { print n+0 }
    ')

if (( count >= THRESHOLD )); then
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs LOOP DETECTED                                             ║
╠═══════════════════════════════════════════════════════════════════╣
║  Tool:        $TOOL_NAME
║  Args hash:   $ARGS_HASH
║  Calls:       $count (in last ${WINDOW_MINUTES} minutes)
║  Threshold:   $THRESHOLD
║                                                                   ║
║  This call has been made repeatedly with identical arguments.     ║
║  This is the signature of a tool-call loop. Session HALTED.       ║
║                                                                   ║
║  What to do:                                                      ║
║    1. Review .workflow/state/tool-call-tracking.jsonl             ║
║    2. Identify why the agent is stuck                             ║
║    3. Write a blocker to .workflow/state/blockers.md              ║
║    4. Either resolve the issue or raise --DEVOPS_LOOP_THRESHOLD   ║
║       if this loop is intentional                                 ║
╚═══════════════════════════════════════════════════════════════════╝
EOF
    # Append blocker
    mkdir -p .workflow/state
    cat >> .workflow/state/blockers.md <<EOF

## Blocker [auto: loop-detection] $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Tool**: $TOOL_NAME
**Args hash**: $ARGS_HASH
**Calls within ${WINDOW_MINUTES} min window**: $count
**Threshold**: $THRESHOLD

**Action**: Session halted by loop-detection hook. Manual intervention required.

EOF
    exit 2
fi

if (( recent_same >= STASIS_LIMIT )); then
    echo "DevOPs SCRATCHPAD STASIS: last $STASIS_LIMIT calls were identical ($CALL_KEY). Halting." >&2
    exit 2
fi

# Record the call
echo "{\"ts\":$TS,\"session_id\":\"$SESSION_ID\",\"call_key\":\"$CALL_KEY\",\"tool\":\"$TOOL_NAME\"}" >> "$TRACKING_FILE"

exit 0
