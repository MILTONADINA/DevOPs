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

# The .claude/settings.json wrapper hands over the PreToolUse payload on stdin
# (--payload-stdin) instead of as an argument, so a command longer than ARG_MAX is
# still classified, and a payload this hook cannot read blocks the call.
if [[ "${1:-}" == --payload-stdin ]]; then
    COMMAND="$(node -e '
        let payload;
        try { payload = JSON.parse(require("fs").readFileSync(0).toString("utf8")); } catch { process.exit(1); }
        const command = payload?.tool_input?.command;
        if (command === undefined || command === null) process.exit(0);
        if (typeof command !== "string") process.exit(1);
        process.stdout.write(command);
    ')" || { echo "DevOPs SEALED-REF BLOCK: the PreToolUse payload is not JSON with a string tool_input.command -- failing closed" >&2; exit 2; }
    [[ -n "$COMMAND" ]] || exit 0
else
    COMMAND="${1:-}"
fi
CLASSIFIER="$(dirname -- "${BASH_SOURCE[0]}")/graph-command-classifier.mjs"
classifier_fault() {
    echo "DevOPs SEALED-REF BLOCK: graph-command-classifier.mjs is missing, failed, or returned an invalid decision" >&2
    exit 2
}

# The shared literal parser compares exact mutation destinations, not substrings.
RESULT="$(printf '%s' "$COMMAND" | node "$CLASSIFIER" sealed -)" || classifier_fault
jq -es '
    length == 1 and (.[0] |
    type == "object" and (.decision == "allow" or .decision == "block") and
    (.reason | type == "string") and (.logAllowed | type == "boolean") and
    (.cycle == null) and (.marker == null) and
    (if .decision == "block" then
        (.sealedRef == null or .sealedRef == "refs/tags/v0.2.0" or
         .sealedRef == "refs/heads/phase-2-security-depth" or
         .sealedRef == "refs/heads/stratum-merge")
     else .sealedRef == null end))
' <<< "$RESULT" >/dev/null || classifier_fault
[[ "$(jq -r '.decision' <<< "$RESULT")" == allow ]] && exit 0
SEALED_REF="$(jq -r '.sealedRef' <<< "$RESULT")"
SEALED_REF_JSON="$(jq -c '.sealedRef' <<< "$RESULT")"
[[ "$SEALED_REF" == null ]] && SEALED_REF="unresolved (classification refused)"
REASON="$(jq -r '.reason' <<< "$RESULT")"
cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs SEALED-REF BLOCK                                          ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Sealed ref involved: $SEALED_REF
║  Reason: $REASON
║
║  These refs anchor claim traceability and the v0.2.0 attestation:
║    refs/tags/v0.2.0
║    refs/heads/phase-2-security-depth
║    refs/heads/stratum-merge
║  See blueprint.md §3 and docs/LAUNCH_READINESS.md.
╚═══════════════════════════════════════════════════════════════════╝
EOF

if [[ "$(jq -r '.logAllowed' <<< "$RESULT")" == true ]]; then
    # The command comes on stdin (-R -s), not argv, so a command longer than an argument is logged (AC-31).
    mkdir -p .workflow/state &&
    printf '%s' "$COMMAND" | jq -cRs --arg ts "$(date -u +%s)" --argjson ref "$SEALED_REF_JSON" --arg pattern "$REASON" \
        '. as $command | {ts:($ts|tonumber),event:"sealed_ref_block",ref:$ref,pattern:$pattern,command:$command}' \
        >> .workflow/state/events.jsonl 2>/dev/null || true
fi
exit 2
