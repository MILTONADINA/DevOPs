---
name: sprint-approve
description: Grant a human-approval marker for a gated graph action (production deploy, or one of two required billing-path approvals). Never invoked by a subagent — this is the mechanism that makes self-approval impossible.
disable-model-invocation: true
---

# /sprint-approve

Writes an approval marker that `hooks/universal/pre-tool/deploy-gate.sh`
checks before allowing a deploy-shaped command or a billing-path
commit/push. This command exists specifically so approval is a real human
action, not something an agent can grant itself — do not build any
automation that calls this on the user's behalf.

## Usage

**Production deploy** (one approval):
```bash
mkdir -p .workflow/state/graph-approvals
echo '{"ts":'"$(date -u +%s)"',"approver":"<your identifier>","cycle":"<cycle id>"}' \
  > .workflow/state/graph-approvals/<cycle id>.deploy
```

**Billing-path change** (two approvals, from distinct approvers — run this
twice, once per approver, with different `approver` values):
```bash
mkdir -p .workflow/state/graph-approvals
echo '{"ts":'"$(date -u +%s)"',"approver":"<your identifier>","cycle":"<cycle id>"}' \
  > .workflow/state/graph-approvals/<cycle id>.billing-1
# second approver, separately:
echo '{"ts":'"$(date -u +%s)"',"approver":"<second approver identifier>","cycle":"<cycle id>"}' \
  > .workflow/state/graph-approvals/<cycle id>.billing-2
```

`deploy-gate.sh` requires the two billing markers' `approver` fields to be
different strings — writing the same marker twice with the same approver
does not satisfy the four-eyes requirement.

Markers are cycle-scoped (`<cycle id>` must match the cycle currently
running) and are not reused across cycles — each new deploy or billing
change needs a fresh approval.

Run as: `/sprint-approve <cycle-id> [--billing]`
