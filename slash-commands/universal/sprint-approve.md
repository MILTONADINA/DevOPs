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

Markers are cycle-scoped (`<cycle id>` must match the cycle currently
running) and are not reused across cycles — each new deploy needs a
fresh approval.

Run as: `/sprint-approve <cycle-id>`
