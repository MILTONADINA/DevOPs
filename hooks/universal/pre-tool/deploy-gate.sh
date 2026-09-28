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
# An inherited GIT_DIR/GIT_WORK_TREE would redirect any git call below to
# another repository regardless of the cwd the wrapper set (third adversarial
# pass, 2026-09-15); the gate must only ever inspect the repo it runs in. No
# git call remains below since the billing check was retired (2026-09-26);
# the unset stays for MR-5, whose signed-approval check compares the
# marker's sha with HEAD.
unset GIT_DIR GIT_WORK_TREE

COMMAND="${1:-}"
CYCLE_ID="${DEVOPS_GRAPH_CYCLE_ID:-current}"
APPROVALS_DIR=".workflow/state/graph-approvals"
HALT_FILE=".workflow/state/graph-halt"

block() {
    local reason="$1"
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs GRAPH DEPLOY-GATE BLOCK                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Reason:  $reason
║                                                                     ║
║  This is a production-deploy action. Per the approved              ║
║  graph-engineering plan, it requires an explicit human approval    ║
║  marker, which a human writes with /sprint-approve.                ║
║                                                                     ║
║  Approval is the user's action, not yours: stop and hand the       ║
║  decision to the user. Do not write a marker under                 ║
║  .workflow/state/graph-approvals/ or remove                        ║
║  .workflow/state/graph-halt yourself. The user approves with       ║
║  /sprint-approve <cycle-id> (1 approval for a deploy), following   ║
║  slash-commands/universal/sprint-approve.md where that command is  ║
║  not installed.                                                    ║
╚═══════════════════════════════════════════════════════════════════╝
EOF
    mkdir -p .workflow/state
    # Build the event with jq --arg so every field is JSON-escaped. The prior
    # `echo ... | jq -R .` encoded only the FIRST line of a multi-line
    # command (jq -R is line-oriented), splitting one event across several
    # lines and corrupting the JSONL -- found 2026-09-14 once the
    # settings.json wrapper started passing multi-line commands through.
    jq -cn --arg ts "$(date -u +%s)" --arg cycle "$CYCLE_ID" --arg reason "$reason" --arg command "$COMMAND" \
        '{ts:($ts|tonumber),event:"deploy_gate_block",cycle:$cycle,reason:$reason,command:$command}' \
        >> .workflow/state/events.jsonl 2>/dev/null || true
    exit 2
}

# Quick exit: not a git/deploy-shaped command, allow. Deliberately checked
# BEFORE the kill switch below -- the halt is scoped to consequential
# actions (deploy/publish/tag/push/commit), not every Bash command in the
# repo. A halted graph must not also block the human operator from running
# `git status`, `ls`, etc. while they investigate.
#
# SECURITY (found by the graph's own security stage, cycle
# phase0-004-claim-validator-investigation, 2026-09-14): this filter was
# previously anchored to the START of the command (`^[[:space:]]*verb`),
# which only catches the literal first-token case. Anything realistic --
# `cd runtime && vercel deploy --prod`, `npx vercel deploy --prod`,
# `VERCEL_TOKEN=x vercel deploy --prod` -- bypassed the gate entirely,
# exiting 0 before any gate logic ran, for both the production-deploy check
# and the billing-path four-eyes check (the latter retired 2026-09-26).
# Fixed to match the verb anywhere it appears as a whole word (preceded by
# start-of-line, whitespace, or a shell operator; followed by whitespace or
# end-of-line),
# not just at position zero. Verified against all three bypass commands
# above (now exit 2) plus a multi-line-command variant -- see the
# .claude/settings.json wrapper fix in the same commit, which was the
# other half of this defect (a single `read -r` only saw the first line of
# a multi-line command, so this regex fix alone would not have been
# sufficient).
if ! echo "$COMMAND" | grep -qE '(^|[;&|(]|[[:space:]])(vercel|wrangler|npm[[:space:]]+publish|git[[:space:]]+(push|commit|tag))([[:space:]]|$)'; then
    exit 0
fi

# Kill switch: if present, no consequential graph-scoped action proceeds.
if [[ -f "$HALT_FILE" ]]; then
    block "graph kill switch is active (.workflow/state/graph-halt exists) -- only the user clears it, with /graph-resume"
fi

# --- Production deploy detection ---
DEPLOY_PATTERNS=(
    "vercel[[:space:]].*--prod"
    "vercel[[:space:]]+deploy"
    "wrangler[[:space:]]+deploy"
    "npm[[:space:]]+publish"
    "git[[:space:]]+push[[:space:]].*--tags"
    "git[[:space:]]+push[[:space:]].*refs/tags/"
)
is_deploy=""
for pattern in "${DEPLOY_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$pattern"; then
        is_deploy=1
        break
    fi
done

if [[ -n "$is_deploy" ]]; then
    marker="$APPROVALS_DIR/${CYCLE_ID}.deploy"
    if [[ ! -f "$marker" ]]; then
        block "production-deploy command with no approval marker at $marker"
    fi
    # Approval marker exists -- allow, but log that a gated deploy proceeded.
    mkdir -p .workflow/state
    echo "{\"ts\":$(date -u +%s),\"event\":\"deploy_gate_approved\",\"cycle\":\"$CYCLE_ID\",\"marker\":\"$marker\"}" >> .workflow/state/events.jsonl
    exit 0
fi

exit 0
