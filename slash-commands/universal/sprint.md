---
name: sprint
description: Run one graph-engineering sprint cycle (plan → code → test → review → security → validate) against the current backlog item, per governance/graph/. Use to drive Phase 0/1 work on SHIP_BLOCKERS.md or plan.md items.
---

# /sprint

Runs `.claude/workflows/sprint-cycle.js` — see `governance/graph/role-mapping.md`
for what each subagent does and `governance/graph/autonomy-config.yml` for
the current phase and gate configuration.

## Before running

1. Check `.workflow/state/graph-halt` does not exist (kill switch). If it
   does, this will simply refuse to start — run `/graph-resume` first if
   that's intentional.
2. Check `governance/graph/autonomy-config.yml`'s `phase:` value. Phase 0
   means every step gets a human checkpoint, no exceptions — do not skip
   checkpoints even if the phase config nominally allows more, since Phase
   0 hasn't graduated yet (see `phase_2_entry_criteria`).
3. Identify the next backlog item: `SHIP_BLOCKERS.md` during Phase 0, then
   `plan.md` / `blueprint.md` afterward.

## Running it

```
Workflow({ scriptPath: ".claude/workflows/sprint-cycle.js", args: { backlogItem: "<id or description>", cycleId: "<a short identifier for this run>" } })
```
Watch the cycle live at http://127.0.0.1:4081 (override the port with `GRAPH_DASHBOARD_PORT`).

The Workflow pipelines the backlog item through planner → coder → tester →
reviewer → security → validator, phase-tagged (Plan/Build/Verify/Release),
and writes cycle state to `.workflow/state/graph-cycles/<cycleId>.md`
following the existing baton pattern (`.workflow/state/baton.md`).

If the cycle reaches a deploy-shaped action or a billing-path change,
`hooks/universal/pre-tool/deploy-gate.sh` will block it and name exactly
what approval is missing. Use `/sprint-approve` to grant it — the graph
cannot self-approve.

## After running

1. Update `governance/graph/stability-dashboard.md` with the cycle's
   outcome row.
2. If this was a Phase 0 cycle, confirm with the user before starting the
   next one — Phase 0 is fully human-gated by design.

Run as: `/sprint <backlog item id or description>`
