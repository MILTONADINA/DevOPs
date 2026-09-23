# Graph role mapping — the "agile team"

Status: **Phase 0 (pilot)**. See `.claude/plans/indexed-launching-cocke.md`
for the full approved plan and `governance/graph/autonomy-config.yml` for
the machine-readable gate configuration this document is the source of
truth for.

This is the durable spec for how DevOPs's existing subagent roster
(`subagents/universal/*.md`) is composed into a graph-engineered
development pipeline. It does not introduce new subagents — it assigns
existing ones to agile-team roles and defines how they hand off to each
other.

## Model assignment (updated 2026-09-14, user directive)

The six build and review roles (planner/coder/tester/reviewer/
security/validator) run on **Sonnet at max reasoning effort**, set
explicitly per `agent()` call in `.claude/workflows/sprint-cycle.js`
(`model: 'sonnet', effort: 'max'`) — not inherited from whatever the
orchestrating session happens to be running, since that would silently
drift with the user's own model choice. See
`cost-controls/model-routing.yml` for the full routing table.
The first role, `preflight`, uses Sonnet at low effort to run
`scripts/graph-preflight.sh --json` before the planner.

## Blocked and resume lifecycle

`/sprint` runs `scripts/graph-preflight.sh` before Workflow. It records the
exact backlog input and each Workflow run id in
`.workflow/state/graph-cycles/<cycleId>/run.json`. A stopped agent or an
environment fault ends the cycle with `BLOCKED_BY_ENVIRONMENT:`. The
orchestrator writes `.workflow/state/blocked.md` using
`scripts/graph-blocked.sh`; that script also records the fault in
`events.jsonl`. `/sprint --resume <cycleId>` repeats preflight and derives
the full continuation args with `scripts/graph-resume-args.mjs`. Only API and
transient faults may resume unattended. The `graph-halt` kill switch remains
human controlled. A `needs_human` block requires the human to run its Fix
command and remove `blocked.md`; the next `/sprint --resume` then checks the
underlying fault with the full preflight. Remaining non-`needs_human` blocks are
cleared by `/sprint --resume` after preflight passes and Workflow launches.

**Fable is the orchestrator** ("boss/CTO") — the top-level entity running
`sprint-cycle.js` and interpreting its results, i.e. the main Claude Code
session. Choosing the session's own model is documentation, not
enforcement: no config file can switch a running session's own model, so
the user selects Fable via `/model` for the main session themselves (done
2026-09-14).

## Roles

| Subagent | Role | Autonomy | Notes |
|---|---|---|---|
| `planner` | Tech lead / backlog refinement | Full (inner loop) | Decomposes a backlog item into atomic tasks. Does **not** set sprint priority or accept/reject scope — that stays human. |
| `coder` | Engineer | Full (inner loop) | Implements one atomic task at a time, surgical edits only. |
| `tester` | QA | Full (inner loop) | Writes/runs tests, produces proof artifacts consumed by `validator`. |
| `reviewer` | Peer review | Full (inner loop) | Spec-anchoring check (real, load-bearing) plus generic diff review. |
| `security` | Security engineer | Full (inner loop), **never bypassed** | The actual least-privilege gate for the 4 pentest MCP tools; anchors the sealed Phase 2 ASI02 control. The graph does not and cannot route around this subagent's scoping. |
| `validator` | Release manager | Full (inner loop) | Independent final re-verification; signs the cycle off before a PR is opened. |
| `integrations-curator` | — | **Parked, out of loop** | Built but unexercised per this session's audit — not part of the sprint cycle. |
| `librarian` | — | **Parked, out of loop** | Confirmed placeholder (not active until Phase 3 ships) per its own file. |

## What "full autonomy in the inner loop" means

The graph runs `planner → coder → tester → reviewer → security → validator`
unattended, end to end, for a backlog item, and opens a PR. No human
approval is required to reach that point.

## The two gates that are never inner-loop-autonomous

1. **Production deploy** — any `vercel deploy --prod`, `wrangler deploy`,
   `npm publish`, or release-tag push. Enforced mechanically by
   `hooks/universal/pre-tool/deploy-gate.sh`, not by asking a subagent to
   "be careful." Requires one human approval marker for the current cycle.
2. **Billing-path changes** — anything touching `stratum/src/billing/`,
   the provider gateway (`stratum/src/proxy/providers/`), or
   `stratum/scripts/invoice*`. Requires **two** human approval markers from
   **distinct** approvers (four-eyes), also enforced by `deploy-gate.sh`.

Neither gate loosens automatically. See the Phase 2 criteria in the
approved plan for the only path to changing this, and it explicitly
excludes these two gates regardless of stability metrics.

## No PM role

Sprint goal-setting and priority stay human. The backlog is
`SHIP_BLOCKERS.md` (current pilot backlog) and `plan.md` (longer-range).
`planner` decomposes what a human has already decided to work on; it does
not decide what to work on.

## Known limitation: commit/push prevention is currently prompt-level, not hook-enforced

Cycle `phase0-001-lockfile` (2026-09-14) surfaced a real gap: the planner
agent decomposed a commit task on its own initiative, and the coder agent
executed a real `git commit` with no human checkpoint — despite Phase 0's
stated rule. The commit itself was clean and correctly scoped, but the
*process* violated the plan.

Root cause: `deploy-gate.sh` only gates deploy-shaped commands and
billing-path commits; it has no way to distinguish a graph-initiated commit
from a human-initiated one for an ordinary (non-billing) path, so a blanket
"all commits need approval" hook would also block normal human-directed
work in this repo. The fix applied is prompt-level: both the planner and
coder prompts in `sprint-cycle.js` now carry a hard constraint not to
stage/commit/push. This is a real fix but not a deterministic one — it
relies on the subagent following the instruction, which is exactly the kind
of enforcement this project's own constitution says not to rely on alone
("you cannot ask an agent if it is in a loop; you must prove it
mathematically").

**Follow-up worth doing before Phase 1**: run `coder`/`tester` with
Workflow's `isolation: 'worktree'` option so their changes land in an
isolated worktree that cannot reach the real working branch, with a
separate explicit human-reviewed merge step -- that would be a genuine
deterministic gate instead of a prompt-level one. Not implemented yet;
tracked here rather than silently assumed fixed.

## Kill switch

`.workflow/state/graph-halt` (presence = halted). Managed via
`/graph-halt` and `/graph-resume`. Checked by `deploy-gate.sh` for every
deploy-shaped or `git push`/`commit`/`tag` command — scoped to consequential
actions, not every Bash call, so a halted graph doesn't also block a human
operator from running ordinary read commands while investigating.
