#!/usr/bin/env bash
# hooks/universal/pre-tool/block-sealed-refs.sh
#
# Blocks git operations that would modify sealed refs:
#   - v0.2.0 tag (sealed at aca4982; per blueprint + LR + baton)
#   - phase-2-security-depth branch (archival; never modify)
#   - stratum-merge branch (archival; never modify)
#
# These refs are part of the project's chain-of-custody. Modifying them
# breaks claim traceability + invalidates the v0.2.0 ship attestation.
#
# Real failure mode this prevents: an agent (me) is mid-refactor, thinks it
# needs to "clean up old branches," and force-deletes archival history.
# Once gone, the audit chain is broken — gone-from-origin + GC'd locally
# means it's gone for good.
#
# References:
#   blueprint.md §3 (locked-in scope: archival refs)
#   docs/LAUNCH_READINESS.md (v0.2.0 sealed; archival branches table)
#   .workflow/state/baton.md (per-session reminder of sealed-ref discipline)

set -euo pipefail

COMMAND="${1:-}"

# Refs that must never be modified (substring match)
SEALED_REFS=(
    "v0.2.0"
    "phase-2-security-depth"
    "stratum-merge"
)

# Patterns that would modify a ref (paired with a sealed ref in the command)
DESTRUCTIVE_GIT_PATTERNS=(
    "git[[:space:]]+tag[[:space:]]+-d"
    "git[[:space:]]+tag[[:space:]]+-f"
    "git[[:space:]]+tag[[:space:]]+--delete"
    "git[[:space:]]+tag[[:space:]]+--force"
    "git[[:space:]]+push[[:space:]]+.*--force"
    "git[[:space:]]+push[[:space:]]+.*--delete"
    "git[[:space:]]+push[[:space:]]+.*-f([[:space:]]|$)"
    "git[[:space:]]+push[[:space:]]+.*-d([[:space:]]|$)"
    "git[[:space:]]+branch[[:space:]]+-D"
    "git[[:space:]]+branch[[:space:]]+--delete[[:space:]]+--force"
    "git[[:space:]]+update-ref[[:space:]]+-d"
    "git[[:space:]]+reset[[:space:]]+--hard"
    "git[[:space:]]+filter-branch"
    "git[[:space:]]+filter-repo"
)

# Quick exit: not a git command, allow
if ! echo "$COMMAND" | grep -qE '^[[:space:]]*git[[:space:]]'; then
    exit 0
fi

# Check if any sealed ref appears in the command
sealed_ref_hit=""
for ref in "${SEALED_REFS[@]}"; do
    if echo "$COMMAND" | grep -qF -- "$ref"; then
        sealed_ref_hit="$ref"
        break
    fi
done

# No sealed ref involved → allow
if [[ -z "$sealed_ref_hit" ]]; then
    exit 0
fi

# Sealed ref involved — check for destructive pattern
destructive_match=""
for pattern in "${DESTRUCTIVE_GIT_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$pattern"; then
        destructive_match="$pattern"
        break
    fi
done

# Read-only operations on sealed refs are fine (git log, git show, git rev-parse, etc.)
if [[ -z "$destructive_match" ]]; then
    exit 0
fi

# Sealed ref + destructive pattern = BLOCK
cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs SEALED-REF BLOCK                                          ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Sealed ref involved: $sealed_ref_hit
║  Destructive pattern: $destructive_match
║                                                                   ║
║  This command would modify a SEALED ref:                          ║
║    - v0.2.0 tag at aca4982 (project ship attestation)             ║
║    - phase-2-security-depth (archival; never modify)              ║
║    - stratum-merge (archival; never modify)                       ║
║                                                                   ║
║  These refs are part of the project's chain-of-custody. They      ║
║  anchor claim traceability + the v0.2.0 attestation. Modifying    ║
║  them breaks audit trail.                                         ║
║                                                                   ║
║  References:                                                      ║
║    blueprint.md §3 (locked-in scope: archival refs)               ║
║    docs/LAUNCH_READINESS.md (sealed-tag + archival-branch tables) ║
║                                                                   ║
║  If you genuinely need to modify a sealed ref (you almost         ║
║  certainly do not): do it manually outside the agent session,     ║
║  document the rationale in baton.md, and update blueprint §3.     ║
╚═══════════════════════════════════════════════════════════════════╝
EOF

# Log the block
mkdir -p .workflow/state
echo "{\"ts\":$(date -u +%s),\"event\":\"sealed_ref_block\",\"ref\":\"$sealed_ref_hit\",\"pattern\":\"$destructive_match\",\"command\":$(echo "$COMMAND" | jq -R . 2>/dev/null || echo "\"$COMMAND\"")}" >> .workflow/state/events.jsonl

exit 2
