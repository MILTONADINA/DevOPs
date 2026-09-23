---
name: graph-halt
description: Kill switch for the graph-engineering pipeline. Immediately blocks all further graph-initiated actions (any deploy-shaped command, any new sprint cycle) until /graph-resume is run.
disable-model-invocation: true
---

# /graph-halt

Creates `.workflow/state/graph-halt`. `hooks/universal/pre-tool/deploy-gate.sh`
checks for this file unconditionally, before any other check, and blocks
every deploy-shaped or billing-path command while it exists. `/sprint`
should also refuse to start a new cycle while it exists (check this at the
top of any sprint-cycle Workflow run).

This is a real human safety control — use it if a running cycle looks
wrong, before investigating further. It does not roll back anything already
done; it only stops new graph actions.

```bash
mkdir -p .workflow/state
echo '{"ts":'"$(date -u +%s)"',"halted_by":"<your identifier>","reason":"<why>"}' \
  > .workflow/state/graph-halt
```

Run as: `/graph-halt <reason>`
