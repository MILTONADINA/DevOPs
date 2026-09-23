---
name: sprint
description: Run one graph-engineering sprint cycle (plan → code → test → review → security → validate) against the current backlog item, per governance/graph/. Use to drive Phase 0/1 work on SHIP_BLOCKERS.md or plan.md items.
---

# /sprint

Runs `.claude/workflows/sprint-cycle.js` — see `governance/graph/role-mapping.md`
for what each subagent does and `governance/graph/autonomy-config.yml` for
the current phase and gate configuration.

## Before running

1. Run `bash scripts/graph-preflight.sh` before calling Workflow. Exit 0 or
   10 permits launch; exit 20 or 2 refuses launch. For a refusal, if
   `.workflow/state/blocked.md` does not yet exist, use
   `scripts/graph-blocked.sh` with stage `preflight`, the failing check ids,
   and the preflight output in a project-local evidence file. For a
   `needs_human` block, supply `--fix` with the exact human action. Print
   the block path and check ids. If the block file exists, leave it unchanged. Never
   remove `.workflow/state/graph-halt`.
2. Check `governance/graph/autonomy-config.yml`'s `phase:` value. Phase 0
   means every step gets a human checkpoint, no exceptions — do not skip
   checkpoints even if the phase config nominally allows more, since Phase
   0 hasn't graduated yet (see `phase_2_entry_criteria`).
3. Identify the next backlog item: `SHIP_BLOCKERS.md` during Phase 0, then
   `plan.md` / `blueprint.md` afterward.

## Running it

For a new cycle, record its exact input before launching:

```
node scripts/graph-run-record.mjs launch --cycle <cycleId> --backlog '<exact backlog item>'
```

```
Workflow({ scriptPath: ".claude/workflows/sprint-cycle.js", args: { backlogItem: "<id or description>", cycleId: "<a short identifier for this run>" } })
```
Watch the cycle live at http://127.0.0.1:4081 (override the port with `GRAPH_DASHBOARD_PORT`).

As soon as Workflow supplies its run id and journal path, update the record:
`node scripts/graph-run-record.mjs update --cycle <cycleId> --status running --runId <runId> --journal <journalPath>`.
On completion, set `--status completed`. On an ordinary failure, set
`--status failed`.

If Workflow throws `BLOCKED_BY_ENVIRONMENT:` parse its JSON payload, set the
run status to `blocked`, and run `bash scripts/graph-blocked.sh` with its
cycle, stage, task, class, check ids and a project-local evidence file. Do
this even when `agent()` returned null, so the block record exists before
the session reports the fault. The script appends `graph.blocked` and
`graph.environment_fault` events to `.workflow/state/events.jsonl`.

For `/sprint --resume <cycleId>`, run the same preflight first. Exit 20 or
2 leaves the block file and run record unchanged. On exit 0 or 10, run
`node scripts/graph-resume-args.mjs <cycleId>` and pass its JSON output as
the *complete* Workflow `args` object. Use `resumeFromRunId` only when the
script and prompts are unchanged; otherwise launch with derived args. Update
the run id, journal path, args, `resumedFrom` and status via
`graph-run-record.mjs update`. Pass `--clearBlocked true` only after the
passing preflight and successful launch. An autonomous loop may resume `api`
and `transient` blocks; `needs_human` and unlisted `environment` remedies
wait for a human fix verified by preflight. A `needs_human` record tells the
human to clear `blocked.md` after performing its Fix command; the full
preflight then verifies the underlying cause on resume. `/sprint` clears
remaining non-`needs_human` markers only after its preflight passes and
the Workflow launches successfully.

The Workflow pipelines the backlog item through preflight → planner → coder
→ tester → reviewer → security → validator, phase-tagged
(Preflight/Plan/Build/Verify/Release). The orchestrator records run state in
`.workflow/state/graph-cycles/<cycleId>/run.json` through
`scripts/graph-run-record.mjs`; the Workflow script has no filesystem API.

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
