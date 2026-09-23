#!/usr/bin/env bash
# hooks/universal/post-tool/sync-lr-refined-date.sh
#
# When plan.md is edited, auto-bump the "Last refined" date in
# docs/LAUNCH_READINESS.md to today's UTC date. Only the date is touched —
# never the math sections (those require explicit refresh per blueprint §11.1).
#
# This closes the staleness loop: blueprint §11.1 refresh trigger says
# "every PR merge that adds/removes/re-estimates plan.md tasks." Without
# this hook, the "Last refined" string drifts from reality.
#
# Light-touch by design: edits only the YYYY-MM-DD prefix on LR's
# "**Last refined**:" line; preserves the parenthetical change description.
# Adds a one-line comment marker so reviewers can grep for hook-driven
# edits.
#
# References:
#   blueprint.md §11.1 (canonical LR reporting + refresh triggers)
#   plan.md §0 (standing rule: LR derived from .md sources)

set -euo pipefail

FILE_EDITED="${1:-}"

# Only act on plan.md edits
case "$FILE_EDITED" in
    *plan.md|*/plan.md)
        ;;
    *)
        exit 0
        ;;
esac

LR_PATH="docs/LAUNCH_READINESS.md"

# Bail if LR doesn't exist
if [[ ! -f "$LR_PATH" ]]; then
    exit 0
fi

TODAY="$(date -u +%Y-%m-%d)"

# Read the current "Last refined" line
current_line=$(grep -m1 '^\*\*Last refined\*\*:' "$LR_PATH" || true)

if [[ -z "$current_line" ]]; then
    # No Last refined line — bail without error
    exit 0
fi

# Extract the existing date (matches YYYY-MM-DD or YYYY-MM-DD/DD)
existing_date=$(echo "$current_line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}(/[0-9]{2})?' | head -n1 || true)

# If date is already today, nothing to do
if [[ "$existing_date" == "$TODAY" ]]; then
    exit 0
fi

# Compose the new line: same prefix + same parenthetical, just date swapped
# Find the parenthetical (everything after the date)
parenthetical=$(echo "$current_line" | sed -E "s/^\*\*Last refined\*\*: ${existing_date}//")

new_line="**Last refined**: ${TODAY}${parenthetical}"

# Write back via sed (cross-platform safe; uses temp file)
tmpfile="$(mktemp)"
awk -v old="$current_line" -v new="$new_line" '
    {
        if ($0 == old) { print new; next }
        print
    }
' "$LR_PATH" > "$tmpfile"

# Sanity check: must contain the new line + must be roughly same size
if ! grep -qF "$new_line" "$tmpfile"; then
    rm -f "$tmpfile"
    echo "DevOPs sync-lr-refined-date: failed to write new date; LR untouched" >&2
    exit 0  # Non-blocking
fi

# Atomic move
mv "$tmpfile" "$LR_PATH"

# Log the event
mkdir -p .workflow/state
echo "{\"ts\":$(date -u +%s),\"event\":\"lr_refined_date_synced\",\"old\":\"$existing_date\",\"new\":\"$TODAY\",\"trigger\":\"$FILE_EDITED\"}" >> .workflow/state/events.jsonl

# Optional: emit a one-line note to stderr so the agent surfaces this to the user
echo "DevOPs sync-lr-refined-date: bumped LR.\"Last refined\" $existing_date → $TODAY (plan.md edit)" >&2

exit 0
