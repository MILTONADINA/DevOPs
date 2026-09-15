#!/usr/bin/env bash
# hooks/universal/pre-tool/deploy-gate.sh
#
# Part of the graph-engineering pipeline (see governance/graph/). Blocks any
# Bash command that would deploy to production, or that would commit/push a
# change touching the billing path, unless the right human-approval markers
# exist for the current cycle. Also honors the graph's kill switch.
#
# Real failure mode this prevents: an autonomous sprint-cycle Workflow (or an
# agent acting on its behalf) reaching the point of actually running
# `vercel deploy --prod` / `wrangler deploy` / pushing a release tag, or
# committing a billing-path change, without a human ever having signed off.
# Per governance/graph/autonomy-config.yml: production deploy requires ONE
# human approval marker; billing-path changes require TWO, from distinct
# approvers. Self-approval by any subagent is not possible — the marker
# files are written by a human via /sprint-approve, not by this hook.
#
# References:
#   .claude/plans/indexed-launching-cocke.md (the approved graph-engineering plan)
#   governance/graph/role-mapping.md
#   governance/graph/autonomy-config.yml

set -euo pipefail
# An inherited GIT_DIR/GIT_WORK_TREE would redirect every git call below to
# another repository regardless of the cwd the wrapper set (third adversarial
# pass, 2026-09-15); the gate must only ever inspect the repo it runs in.
unset GIT_DIR GIT_WORK_TREE

COMMAND="${1:-}"
CYCLE_ID="${DEVOPS_GRAPH_CYCLE_ID:-current}"
APPROVALS_DIR=".workflow/state/graph-approvals"
HALT_FILE=".workflow/state/graph-halt"

# Billing-path globs (kept in sync with governance/graph/autonomy-config.yml's
# billing_paths list -- if you change one, change both).
BILLING_PATH_PATTERNS=(
    "stratum/src/billing/"
    "stratum/src/proxy/providers/"
    "stratum/scripts/invoice"
)

block() {
    local reason="$1"
    cat >&2 <<EOF
╔═══════════════════════════════════════════════════════════════════╗
║  DevOPs GRAPH DEPLOY-GATE BLOCK                                    ║
╠═══════════════════════════════════════════════════════════════════╣
║  Command: $COMMAND
║  Reason:  $reason
║                                                                     ║
║  This is a production-deploy or billing-path action. Per the       ║
║  approved graph-engineering plan, these require explicit human     ║
║  approval markers -- an autonomous cycle cannot self-approve.      ║
║                                                                     ║
║  To approve: run /sprint-approve (production deploy, 1 approval)   ║
║  or /sprint-approve --billing (billing-path change, 2 approvals    ║
║  from distinct approvers required).                                ║
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
# `cd stratum && vercel deploy --prod`, `npx vercel deploy --prod`,
# `VERCEL_TOKEN=x vercel deploy --prod` -- bypassed the gate entirely,
# exiting 0 before any gate logic ran, for BOTH the production-deploy check
# and the billing-path four-eyes check below (same gate). Fixed to match
# the verb anywhere it appears as a whole word (preceded by start-of-line,
# whitespace, or a shell operator; followed by whitespace or end-of-line),
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
    block "graph kill switch is active (.workflow/state/graph-halt exists) -- run /graph-resume to clear it"
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

# --- Billing-path four-eyes check (git commit / git push only) ---
if echo "$COMMAND" | grep -qE '^[[:space:]]*git[[:space:]]+(commit|push)'; then
    touches_billing=""
    changed_files=""
    if echo "$COMMAND" | grep -qE '^[[:space:]]*git[[:space:]]+commit'; then
        changed_files=$(git diff --cached --name-only 2>/dev/null || true)
    else
        # git push: check what's outgoing relative to the upstream, if known
        upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
        if [[ -n "$upstream" ]]; then
            changed_files=$(git diff "${upstream}..HEAD" --name-only 2>/dev/null || true)
        fi
    fi

    if [[ -n "$changed_files" ]]; then
        for pattern in "${BILLING_PATH_PATTERNS[@]}"; do
            if echo "$changed_files" | grep -qF "$pattern"; then
                touches_billing=1
                break
            fi
        done
    fi

    if [[ -n "$touches_billing" ]]; then
        marker1="$APPROVALS_DIR/${CYCLE_ID}.billing-1"
        marker2="$APPROVALS_DIR/${CYCLE_ID}.billing-2"
        if [[ ! -f "$marker1" || ! -f "$marker2" ]]; then
            block "billing-path change (matches: ${BILLING_PATH_PATTERNS[*]}) needs TWO approval markers, found: $( [[ -f "$marker1" ]] && echo 1 || echo 0 )/2"
        fi
        approver1=$(jq -r '.approver // empty' "$marker1" 2>/dev/null || true)
        approver2=$(jq -r '.approver // empty' "$marker2" 2>/dev/null || true)
        if [[ -z "$approver1" || -z "$approver2" || "$approver1" == "$approver2" ]]; then
            block "billing-path change needs two markers from DISTINCT approvers (got '$approver1' and '$approver2')"
        fi
        mkdir -p .workflow/state
        echo "{\"ts\":$(date -u +%s),\"event\":\"billing_gate_approved\",\"cycle\":\"$CYCLE_ID\",\"approvers\":[\"$approver1\",\"$approver2\"]}" >> .workflow/state/events.jsonl
    fi
fi

exit 0
