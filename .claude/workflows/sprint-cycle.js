export const meta = {
  name: 'sprint-cycle',
  description: 'Run one graph-engineering sprint cycle (plan -> code -> test -> review -> security -> validate) for one backlog item',
  phases: [
    { title: 'Preflight', detail: 'check the checkout and toolchain before planning' },
    { title: 'Plan', detail: 'planner decomposes the backlog item into atomic tasks' },
    { title: 'Build', detail: 'coder implements, tester writes/runs tests, per task' },
    { title: 'Verify', detail: 'reviewer + security + validator sign off' },
    { title: 'Release', detail: 'summarize the cycle outcome' },
  ],
}

// governance/graph/role-mapping.md is the durable spec this script implements.
// This Workflow does NOT commit, push, open a PR, or run any deploy action --
// those stay outside its scope, gated by hooks/universal/pre-tool/deploy-gate.sh
// and human approval (/sprint-approve) per the approved plan
// (.claude/plans/indexed-launching-cocke.md). Phase 0 requires a human
// checkpoint at every step -- this script produces the cycle's results for a
// human to review; it does not act on them unattended.

const backlogItem = args && args.backlogItem
const cycleId = (args && args.cycleId) || 'unnamed-cycle'
const BLOCKED_SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string' },
    check_ids: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' },
    classified_by: { type: 'string' },
  },
  required: ['class', 'check_ids', 'evidence'],
}
const ENVIRONMENT_RULES = `ENVIRONMENT RULES: On any tool or test failure, pass its first 20 error lines to node scripts/graph-classify-fault.mjs (with --exit-code when known). Record its class and classified_by; for an unrecognized error, supply --agent-class and explain that judgment. Code failures follow normal review and are never retried as flaky. For an environment or API fault, run bash scripts/graph-preflight.sh once. If it does not report ready/remediated, call bash scripts/graph-blocked.sh with the cycle, stage, task, class, check ids and a project-local evidence file; return blocked_by_environment with class, check_ids, evidence and classified_by, then stop. A scratchpad check does not make an unrun suite pass.`

if (!backlogItem) {
  throw new Error('sprint-cycle requires args.backlogItem -- the backlog item id/description to work (see SHIP_BLOCKERS.md)')
}

log(`Starting sprint cycle "${cycleId}" for backlog item: ${backlogItem}`)

function stopIfBlocked(result, stage, taskId) {
  if (result !== null && !result?.blocked_by_environment) return result
  const blocked = result?.blocked_by_environment || {}
  const fault = {
    cycleId,
    stage,
    ...(taskId ? { taskId } : {}),
    class: blocked.class || 'api',
    check_ids: blocked.check_ids || [],
    evidence: blocked.evidence || (result === null ? 'agent() returned null' : ''),
    classified_by: blocked.classified_by || (result === null ? 'signature' : 'agent'),
  }
  log(`Cycle blocked at ${stage}: ${JSON.stringify(fault)}`)
  throw new Error(`BLOCKED_BY_ENVIRONMENT:${JSON.stringify(fault)}`)
}

async function workflowAgent(prompt, options) {
  const result = await agent(prompt, options)
  const [stage, taskId] = options.label.split(':')
  return stopIfBlocked(result, stage, taskId)
}

phase('Preflight')
const preflight = await workflowAgent(
  `You are the preflight role. Run bash scripts/graph-preflight.sh --json in the project root and return its parsed status and failing check ids. Do not start planning or edit files.`,
  {
    label: 'preflight',
    phase: 'Preflight',
    model: 'sonnet',
    effort: 'low',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        check_ids: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'string' },
        blocked_by_environment: BLOCKED_SCHEMA,
      },
      required: ['status', 'check_ids'],
    },
  }
)
if (preflight.status === 'needs_human' || preflight.status === 'error') {
  stopIfBlocked({ blocked_by_environment: {
    class: preflight.status === 'needs_human' ? 'needs_human' : 'environment',
    check_ids: preflight.check_ids,
    evidence: preflight.evidence || preflight.status,
  } }, 'preflight')
}

phase('Plan')
// Continuation support: when a cycle's prompts change mid-run (e.g. the tester
// prompt was hardened after the cycle started), the Workflow resume cache
// cannot replay the later stages. The orchestrator may then pass the earlier
// run's `plan` and `priorBuildResults` (from that run's journal.jsonl) so the
// planner is not re-run and completed tasks are carried forward unchanged.
let plan = (args && args.plan) || null
if (plan) log(`Using the precomputed plan from prior run ${(args && args.resumedFrom) || '(unspecified)'} (${plan.tasks ? plan.tasks.length : 0} tasks); planner not re-run`)
else plan = await workflowAgent(
  `You are acting as the 'planner' role in the DevOPs graph-engineering pipeline (see governance/graph/role-mapping.md at the repo root). Read the backlog item below and, if it references SHIP_BLOCKERS.md or plan.md, read the relevant section there for full context:

Backlog item: "${backlogItem}"

Decompose it into a small ordered list of atomic, independently-verifiable tasks. Do not write or edit any code yourself -- this is decomposition only. Do not expand scope beyond what the backlog item actually asks for. If anything about the item is ambiguous or underspecified, report it as an ambiguity rather than guessing at intent.

HARD CONSTRAINT: do not include any task whose job is to stage, commit, or push a git change, open a pull request, or run any deploy/publish command. This pipeline's scope ends at implementation + verification (coder/tester/reviewer/security/validator) -- committing and pushing are a separate, explicitly human-reviewed step outside this Workflow, never an autonomous task in your plan.`,
  {
    label: 'planner',
    phase: 'Plan',
    model: 'sonnet',
    effort: 'max',
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              files_likely_touched: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'description'],
          },
        },
        ambiguities: { type: 'array', items: { type: 'string' } },
        blocked_by_environment: BLOCKED_SCHEMA,
      },
      required: ['tasks'],
    },
  }
)

if (!plan || !plan.tasks || plan.tasks.length === 0) {
  throw new Error(`planner produced no tasks for backlog item "${backlogItem}" -- cycle cannot proceed`)
}

log(`Planner produced ${plan.tasks.length} task(s)` + (plan.ambiguities && plan.ambiguities.length ? `, ${plan.ambiguities.length} ambiguity(ies) flagged -- see result.plan.ambiguities` : ''))

phase('Build')
// Sequential per task, not parallel: tasks from the same backlog item may
// touch overlapping files, and Phase 0 favors safety over throughput (see
// the approved plan). coder and tester run one after another per task so
// tester always sees that task's real diff.
const buildResults = []
const priorBuild = (args && Array.isArray(args.priorBuildResults)) ? args.priorBuildResults : []
// A task whose coder finished but whose tester did not (e.g. the tester
// stalled and the run was killed): carry the coder result forward and run
// only the tester, so the coder is not re-run on top of its own output.
const priorCoder = (args && Array.isArray(args.priorCoderResults)) ? args.priorCoderResults : []
for (const task of plan.tasks) {
  const done = priorBuild.find(r => r && r.task && r.task.id === task.id)
  if (done) {
    stopIfBlocked(done.coderResult, 'coder', task.id)
    stopIfBlocked(done.testerResult, 'tester', task.id)
    buildResults.push(done)
    log(`Skipping ${task.id}: completed in prior run ${(args && args.resumedFrom) || '(unspecified)'} -- its coder/tester results are carried forward for review`)
    continue
  }
  const codedBefore = priorCoder.find(r => r && r.task && r.task.id === task.id)
  if (codedBefore) log(`${task.id}: coder result carried forward from prior run ${(args && args.resumedFrom) || '(unspecified)'}; running the tester only`)
  const coderResult = codedBefore ? stopIfBlocked(codedBefore.coderResult, 'coder', task.id) : await workflowAgent(
    `You are acting as the 'coder' role in the DevOPs graph-engineering pipeline. Implement exactly this atomic task -- surgical edits only, nothing beyond its stated scope:

Task id: ${task.id}
Description: ${task.description}
Likely files: ${JSON.stringify(task.files_likely_touched || [])}

Report what you actually changed (it may differ from "likely files" above).

${ENVIRONMENT_RULES}

HARD CONSTRAINT: do not run \`git add\`, \`git commit\`, \`git push\`, or any deploy/publish command, even if the task description above seems to call for it. Leave changes uncommitted in the working tree. Committing is a separate, explicitly human-reviewed step outside this pipeline's scope.`,
    {
      label: `coder:${task.id}`,
      phase: 'Build',
      model: 'sonnet',
      effort: 'max',
      schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          blocked_by_environment: BLOCKED_SCHEMA,
        },
        required: ['task_id', 'summary'],
      },
    }
  )

  const testerResult = await workflowAgent(
    `You are acting as the 'tester' role in the DevOPs graph-engineering pipeline. For the task just implemented (id ${task.id}: ${task.description}), write and/or run whatever tests are appropriate to verify it, and produce a proof artifact per this project's proof-of-work convention (skills/universal/process/proof-of-work/SKILL.md at the repo root): the actual command run, its exit code, and a tail of its output. Report pass/fail honestly -- do not paper over a failure or claim success without having actually run something.

Coder's report for this task: ${JSON.stringify(coderResult)}

${ENVIRONMENT_RULES}

STALL RULES (a tester that makes no tool progress for 3 minutes is killed and the whole cycle fails): never run a server or watcher in the foreground of a Bash call -- start it in the background with a bounded wait and kill it before you return; put a timeout on every network call; if a tool you were told to use (for example a Playwright/browser MCP tool) is not available in your tool list, do NOT wait, poll or retry for it -- do the closest verification you can with the tools you have, state explicitly in your report that the browser step was not performed and why, and let passed reflect only the assertions you actually ran.

CLAIM-SCHEMA CONSTRAINT (if you write a claim YAML under .workflow/proofs/): it must validate against verification/claim-schema.yml, or it is proof theater. Concretely: id matches claim-YYYY-MM-DD-NNN using the next free NNN in that directory; spec_ref starts with specs/ (use the nearest real anchor under specs/ and say in caveats when it is nominal -- never invent a path, never use SHIP_BLOCKERS.md or a task id); files_changed lists only tracked files the eventual commit will contain (never gitignored proof/state files); test_command is a re-runnable command with no placeholders; reproducibility_hash = "sha256:" + sha256(test_command + "\\n---\\n" + sorted "key=value" lines of proof.environment (empty string if absent) + "\\n---\\n" + git_sha); and the proof script must not depend on the caller's npm verbosity (unset npm_config_loglevel at the top if it invokes npm) or on HEAD equalling a specific SHA (assert reachability with git merge-base --is-ancestor instead). Confirm with npm run validate:claims -- --no-rerun on your claim before reporting. When the claim is about a commit, assert exact-set invariants against THAT commit's content (git show <git_sha>:<path>), never against the live working tree -- later commits and concurrent cycles legitimately change it -- and check only durable invariants ("X is absent") live. If a scanner is part of the proof, the proof must fail when the scanner scanned nothing, and must be shown to fail on a planted positive (e.g. gitleaks' default config silently skips files named package-lock.json).`,
    {
      label: `tester:${task.id}`,
      phase: 'Build',
      model: 'sonnet',
      effort: 'max',
      schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          command: { type: 'string' },
          exit_code: { type: 'number' },
          passed: { type: 'boolean' },
          output_tail: { type: 'string' },
          blocked_by_environment: BLOCKED_SCHEMA,
        },
        required: ['task_id', 'passed'],
      },
    }
  )

  buildResults.push({ task, coderResult, testerResult })
}

const failedTasks = buildResults.filter(r => r.testerResult && r.testerResult.passed === false)
if (failedTasks.length > 0) {
  log(`${failedTasks.length} of ${buildResults.length} task(s) failed testing -- cycle still proceeds to Verify so reviewer/security/validator see the failure, but it should not be approved.`)
}

phase('Verify')
const reviewResult = await workflowAgent(
  `You are acting as the 'reviewer' role in the DevOPs graph-engineering pipeline. Review this cycle's changes against the original backlog item and its spec.

Backlog item: "${backlogItem}"
Tasks: ${JSON.stringify(plan.tasks)}
Build results: ${JSON.stringify(buildResults.map(r => ({ task: r.task.id, coder: r.coderResult, tester: r.testerResult })))}

Check spec-anchoring (does every changed line trace to one of the tasks above, or to the backlog item itself?) and general diff quality. Report any violations plainly -- do not soften a real finding.

${ENVIRONMENT_RULES}`,
  {
    label: 'reviewer',
    phase: 'Verify',
    model: 'sonnet',
    effort: 'max',
    schema: {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        violations: { type: 'array', items: { type: 'string' } },
        blocked_by_environment: BLOCKED_SCHEMA,
      },
      required: ['approved'],
    },
  }
)

const securityResult = await workflowAgent(
  `You are acting as the 'security' role in the DevOPs graph-engineering pipeline, per subagents/universal/security.md's scoping at the repo root -- you are the only role in this pipeline permitted to invoke the pentest MCP tools, and only if this task's nature genuinely requires it; do not exceed your declared scope. Run the tiered security scan stack (gitleaks, semgrep, dependency check as applicable) on this cycle's changes.

Backlog item: "${backlogItem}"
Build results: ${JSON.stringify(buildResults.map(r => ({ task: r.task.id, coder: r.coderResult })))}

Report findings above threshold plainly, or confirm none were found.

${ENVIRONMENT_RULES}

CLAIM-SCHEMA CONSTRAINT (if you record your scan as a claim YAML under .workflow/proofs/): it must validate against verification/claim-schema.yml -- id claim-YYYY-MM-DD-NNN (next free NNN), a specs/ spec_ref (specs/phase-2/A-pentest-stack.md#req-a8 is the real anchor for a secrets/static scan of committed files), files_changed limited to tracked files, a RE-RUNNABLE test_command with no <placeholders> (write a small proof script that re-extracts the changed files at the commit and re-runs the deterministic tiers; keep drifting checks like npm audit informational), and a reproducibility_hash computed with the validator's formula. A scan claim that cannot be re-run is not evidence.`,
  {
    label: 'security',
    phase: 'Verify',
    model: 'sonnet',
    effort: 'max',
    schema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        findings: { type: 'array', items: { type: 'string' } },
        blocked_by_environment: BLOCKED_SCHEMA,
      },
      required: ['passed'],
    },
  }
)

const validatorResult = await workflowAgent(
  `You are acting as the 'validator' role in the DevOPs graph-engineering pipeline -- independent final re-verification, the last check before this cycle could be considered for a PR. Re-run the tester's proofs yourself rather than trusting the reported output where feasible; recompute exit codes rather than assuming they're accurate.

Backlog item: "${backlogItem}"
Build results: ${JSON.stringify(buildResults.map(r => ({ task: r.task.id, coder: r.coderResult, tester: r.testerResult })))}
Reviewer result: ${JSON.stringify(reviewResult)}
Security result: ${JSON.stringify(securityResult)}

${ENVIRONMENT_RULES}

Decide whether this cycle is ready for a PR. Do NOT sign off if any task's test failed, the reviewer found violations, or security found findings above threshold. State your reason either way.`,
  {
    label: 'validator',
    phase: 'Verify',
    model: 'sonnet',
    effort: 'max',
    schema: {
      type: 'object',
      properties: {
        signed_off: { type: 'boolean' },
        reason: { type: 'string' },
        blocked_by_environment: BLOCKED_SCHEMA,
      },
      required: ['signed_off', 'reason'],
    },
  }
)

phase('Release')
const readyForPR = !!(validatorResult && validatorResult.signed_off) && failedTasks.length === 0

const cycleOutcome = {
  cycleId,
  backlogItem,
  taskIds: plan.tasks.map(t => t.id),
  anyTestFailed: failedTasks.length > 0,
  reviewApproved: !!(reviewResult && reviewResult.approved),
  securityPassed: !!(securityResult && securityResult.passed),
  validatorSignedOff: !!(validatorResult && validatorResult.signed_off),
  readyForPR,
}

log(`Cycle "${cycleId}" outcome: ${readyForPR ? 'READY for PR (pending human review)' : 'NOT ready'}`)
if (!readyForPR) {
  log(`Validator reason: ${validatorResult ? validatorResult.reason : 'validator did not return a result'}`)
}

return {
  cycleOutcome,
  plan,
  buildResults,
  reviewResult,
  securityResult,
  validatorResult,
  note: 'This Workflow does not commit, push, open a PR, or run any deploy/git-push action -- those remain outside its scope, gated by hooks/universal/pre-tool/deploy-gate.sh and explicit human approval (/sprint-approve) per governance/graph/. Whoever ran /sprint is responsible for reviewing this outcome, writing it into .workflow/state/graph-cycles/ and governance/graph/stability-dashboard.md, and deciding next steps -- Phase 0 has no autonomous continuation.',
}
