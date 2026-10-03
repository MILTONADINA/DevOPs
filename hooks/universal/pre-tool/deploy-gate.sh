#!/usr/bin/env bash
# hooks/universal/pre-tool/deploy-gate.sh
#
# Part of the graph-engineering pipeline (see governance/graph/). Blocks any
# Bash command that would deploy to production, unless the right human-
# approval marker exists for the current cycle. Also honors the graph's
# kill switch.
#
# Real failure mode this prevents: an autonomous sprint-cycle Workflow (or an
# agent acting on its behalf) reaching the point of actually running
# `vercel deploy --prod` / `wrangler deploy` / pushing a release tag, without
# a human ever having signed off. Per governance/graph/autonomy-config.yml:
# production deploy requires ONE human approval marker. Approval markers are
# plain files that a human writes via /sprint-approve, but nothing today
# stops an agent from creating one directly: the Write/Edit tools have no
# PreToolUse hook at all, and this hook only inspects Bash commands for
# deploy/push/tag verbs, not writes into the approvals directory. Signed
# markers (masterpiece REQ-M15/MR-5) and protected paths for the approvals
# directory (MR-4) are the planned, not-yet-built fix.
#
# References:
#   .claude/plans/indexed-launching-cocke.md (the approved graph-engineering plan)
#   governance/graph/role-mapping.md
#   governance/graph/autonomy-config.yml

set -euo pipefail

COMMAND="${1:-}"
CLASSIFIER="$(dirname -- "${BASH_SOURCE[0]}")/graph-command-classifier.mjs"
classifier_fault() {
    echo "DevOPs DEPLOY-GATE BLOCK: graph-command-classifier.mjs is missing, failed, or returned an invalid decision" >&2
    exit 2
}

# REQ-M16: command text is one inert argv; the companion never evaluates it.
RESULT="$(node "$CLASSIFIER" deploy "$COMMAND")" || classifier_fault
jq -es '
    length == 1 and (.[0] |
    type == "object" and
    (.decision == "allow" or .decision == "block" or .decision == "approved") and
    (.reason | type == "string") and (.logAllowed | type == "boolean") and
    (.cycle == null or (.cycle | type == "string" and test("^[A-Za-z0-9_-]+$"))) and
    (.marker == null or (.marker | type == "string")) and
    (.sealedRef == null) and
    (if .decision == "approved" then
        .cycle != null and .marker == (".workflow/state/graph-approvals/" + .cycle + ".deploy")
     else true end))
' <<< "$RESULT" >/dev/null || classifier_fault
DECISION="$(jq -r '.decision' <<< "$RESULT")"
[[ "$DECISION" == allow ]] && exit 0
REASON="$(jq -r '.reason' <<< "$RESULT")"
CYCLE_JSON="$(jq -c '.cycle' <<< "$RESULT")"
LOG_ALLOWED="$(jq -r '.logAllowed' <<< "$RESULT")"

if [[ "$DECISION" == block ]]; then
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs GRAPH DEPLOY-GATE BLOCK                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Reason:  $REASON
║
║  The user clears a halt with /graph-resume and approves a deploy
║  with /sprint-approve <cycle-id>. Follow
║  slash-commands/universal/sprint-approve.md if it is not installed.
║  Do not create an approval marker or remove the halt yourself.
╚═══════════════════════════════════════════════════════════════════╝
EOF
    if [[ "$LOG_ALLOWED" == true ]]; then
        # The classifier checks the state/event path before permitting a write.
        # jq --arg keeps a multiline command in one escaped JSONL event.
        mkdir -p .workflow/state &&
        jq -cn --arg ts "$(date -u +%s)" --argjson cycle "$CYCLE_JSON" --arg reason "$REASON" --arg command "$COMMAND" \
            '{ts:($ts|tonumber),event:"deploy_gate_block",cycle:$cycle,reason:$reason,command:$command}' \
            >> .workflow/state/events.jsonl 2>/dev/null || true
    fi
    exit 2
fi

if [[ "$LOG_ALLOWED" == true ]]; then
    MARKER="$(jq -r '.marker' <<< "$RESULT")"
    mkdir -p .workflow/state &&
    jq -cn --arg ts "$(date -u +%s)" --argjson cycle "$CYCLE_JSON" --arg marker "$MARKER" \
        '{ts:($ts|tonumber),event:"deploy_gate_approved",cycle:$cycle,marker:$marker}' \
        >> .workflow/state/events.jsonl 2>/dev/null || true
fi
exit 0
