---
name: sprint-approve
description: Grant a human-approval marker for a gated graph action. Only a human runs it; nothing yet stops an agent's file tools from writing a marker directly (signed markers, MR-5, and protected paths, MR-4, are the planned fix).
disable-model-invocation: true
---

# /sprint-approve

Writes an approval marker that `hooks/universal/pre-tool/deploy-gate.sh`
checks before allowing a deploy-shaped command. (The billing-path
four-eyes gate was retired on 2026-09-26 by owner decision.) This command
exists so approval is a human action. Agents must never write a marker or
call this command; nothing yet enforces that for their file tools, so do
not build any automation that calls this on the user's behalf.

## Usage

**Production deploy** (one approval):
```bash
mkdir -p .workflow/state/graph-approvals
echo '{"ts":'"$(date -u +%s)"',"approver":"<your identifier>","cycle":"<cycle id>"}' \
  > .workflow/state/graph-approvals/<cycle id>.deploy
```

The marker name must match the sole valid `running` record under
`.workflow/state/graph-cycles/*/run.json`, including its directory and recorded
cycle ID. Missing, invalid, unreadable, redirected or ambiguous run authority
refuses deployment. `current.deploy` and `DEVOPS_GRAPH_CYCLE_ID` do not select a
cycle. Null optional Workflow run/journal IDs are valid for a newly launched
record.

Approval remains human-only and cycle-scoped. Obtain fresh approval for each
deploy; the hook checks marker presence and does not mechanically consume it
once per action. Plain marker files do not authenticate the approver:
signatures and file-tool protection remain MR-5/MR-4. A marker never overrides
`graph-halt` or the separate sealed-ref hook. Unhalted `gh pr merge` remains
exempt from this marker requirement under roadmap Decision 13 and must satisfy
the required merge checks.

Run as: `/sprint-approve <cycle-id>`
