# Graph / Area R — Environment Resilience for the Sprint Pipeline

**Spec ID**: graph/R-resilience
**Status**: draft (backlog item for graph cycle 7)
**Last updated**: 2026-09-23
**Owner**: miltonadina
**Reviewers**: miltonadina (orchestrator session: Claude Fable 5.1)

---

## Context

The graph-engineering pipeline (`.claude/workflows/sprint-cycle.js`, roles in
`governance/graph/role-mapping.md`) ran six cycles against SHIP_BLOCKERS.md
and fixed the project defects it was pointed at. Every interruption it
suffered was an **environment** fault, and every one needed the orchestrator
to intervene by hand:

| Date | Fault | What happened | Human/orchestrator work it cost |
|---|---|---|---|
| 2026-09-14 | API account session limit | 10 of cycle 6's tasks failed mid-run | resume arguments (`plan`, `priorBuildResults`) hand-assembled from the run journal |
| 2026-09-15 | API outage | one tester stalled until the run was killed | `priorCoderResults` added by hand, run relaunched |
| 2026-09-15 07:30 | App Store updated Xcode | `/usr/bin/git` (Apple's xcrun shim) refused every command until `sudo xcodebuild -license accept`; all six `tests/graph-dashboard/*.test.mjs` died with it because they resolve the repo root through a `git` subprocess | diagnosis, a `~/.local/bin/git` shim to the Command Line Tools git, PB-55 |

The user's requirement, stated 2026-09-15: *"the graph should dynamically
adapt to the project and just work."* The cycle-6 coder did adapt (it
diagnosed a dead toolchain, verified with a scratchpad harness, kept going),
but the pipeline had no way to detect the fault before starting, no way to
classify it, no durable run record to resume from, and no human-actionable
"blocked" state. This spec closes those gaps.

Research basis (desk research 2026-09-15, sources with URLs and dates in
`governance/graph/research-resilience-2026-09-15.md`): Homebrew/Flutter `doctor` semantics; Kubernetes liveness/readiness
split; Google's flaky-test classification-before-retry rule; DORA's 2023
separation of change-caused failures from infrastructure failures; Buildkite's
distinct retry policy for agent-lost exits; Anthropic's *Building Effective
Agents* (let the agent adapt to a failing tool, inside deterministic limits)
and the Claude API error docs (a spend-cap `429` has no `retry-after` and
must not be retried; `529` is transient); Temporal/LangGraph/Inngest
checkpoint semantics (persist run id, exact inputs, per-step outputs before a
step counts as done); Bazel hermeticity (tests declare their inputs, never
shell out for something derivable in-process); Ewaschuk's "every page must be
actionable" and Strömberg's playbook-entry anatomy for the blocked record;
OWASP Agentic Top 10 2026 on kill switches.

## Constraints the design must respect

- Workflow scripts have **no filesystem, timers, or Node APIs** — only
  `agent()`, `pipeline()`, `parallel()`, `log()`, `phase()`, `args`. Anything
  that must be written to disk is written by a subagent, a hook, or the
  orchestrator session, never by `sprint-cycle.js` itself.
- The Workflow tool already retries transient API errors inside the SDK and
  returns `null` from `agent()` on a terminal API error; a subagent that
  makes no tool progress for 3 minutes is killed. The script cannot change
  those policies, only react to their outcomes.
- The production-deploy and billing four-eyes gates, and the `graph-halt`
  kill switch, are unchanged (`governance/graph/autonomy-config.yml`).
- Nothing in this spec may run `sudo`, accept a license, rotate a credential,
  or spend money on the user's behalf.

## Out of scope

- Fixing project bugs surfaced by the checks (those become backlog items).
- Retry/backoff of individual model calls (owned by the SDK/Workflow tool).
- Cross-machine resume; the run record is for this checkout.
- Re-architecting tests beyond removing toolchain subprocess dependencies.

## Actors and data

- **Primary actors**: `/sprint` (orchestrator session), `sprint-cycle.js`
  agents (planner, coder, tester, reviewer, security, validator), the
  `SessionStart` hook, the human.
- **Data**: `.workflow/state/preflight.json`, `.workflow/state/blocked.md`,
  `.workflow/state/graph-cycles/<cycleId>/run.json`, the audit sink
  `.workflow/state/events.jsonl`. No PII; no secrets are written (the
  preflight reports *whether* a tool authenticates, never a token).
- **Compliance scope**: [x] none.

---

## Functional requirements (EARS)

### REQ-R1 (Ubiquitous) — A deterministic preflight exists and is the single source of "ready"
THE SYSTEM SHALL provide `scripts/graph-preflight.sh` that, with no arguments, verifies at minimum: (i) `git rev-parse --show-toplevel` succeeds and `git ls-remote --exit-code origin HEAD` succeeds within 20 s; (ii) `node --version` satisfies `package.json` `engines.node`; (iii) `npm --version` runs; (iv) `node_modules` exists at the DevOps root and under `stratum/`, and every file in each `node_modules/.bin/` is executable; (v) `gitleaks`, `semgrep` and `cosign` resolve on PATH or `~/bin` and report a version; (vi) `.workflow/state/` and `.workflow/proofs/` are writable; (vii) `.workflow/state/graph-halt` is absent; (viii) `.workflow/state/blocked.md` is absent or its `class` is not `needs_human`. Each check SHALL be a named function with a stable id (`git.runs`, `git.remote`, `node.version`, …).

### REQ-R2 (Ubiquitous) — Dual-mode report at a fixed path
THE SYSTEM SHALL make the preflight write `.workflow/state/preflight.json` (`{schema_version, ran_at, git_sha, status: ready|remediated|needs_human|error, checks: [{id, status: pass|fail|fixed|skipped, evidence, remedy?}]}`) AND print a one-line-per-check human table with ✓/✗/! markers, and SHALL exit 0 for `ready`, 10 for `remediated` (a fix was applied and the re-check passed), 20 for `needs_human`, 2 for internal error. It SHALL never print a secret value.

### REQ-R3 (Event-driven) — Known safe remediations are applied automatically; nothing else is
WHEN a check fails and `governance/graph/preflight-remediations.yml` lists a remediation for that check id, THE SYSTEM SHALL apply it, re-run the check, and record `fixed` with the command used. The remediation registry SHALL contain, for each entry, `check_id`, `detect` (the exact evidence string or predicate), `apply`, `revert`, `reversible: true`, `needs_sudo: false`, and a `why` line. The initial registry SHALL cover: the xcrun-license git block (route `git` to `/Library/Developer/CommandLineTools/usr/bin/git` via a shim in the first PATH directory the user owns, exactly the PB-55 workaround), missing exec bits on `node_modules/.bin/*` (`chmod +x`), and a missing `cosign` (install the version pinned in `.github/workflows/release-sign.yml` into `~/bin` with its published sha256 verified). Any check whose remedy needs `sudo`, a license acceptance, a credential, or a purchase SHALL be reported as `needs_human` with the exact command, never executed.

### REQ-R4 (Event-driven) — Preflight runs before any cycle starts
WHEN `/sprint` is invoked, THE SYSTEM SHALL run the preflight first and SHALL refuse to launch the Workflow on exit 20 or 2, printing the blocked record path. WHEN `sprint-cycle.js` starts, its first `agent()` call SHALL be a `preflight` role (`effort: 'low'`) that runs `scripts/graph-preflight.sh --json` and returns the parsed `status` and failing check ids; IF the status is `needs_human` or `error`, THEN the script SHALL throw an error whose message begins `BLOCKED_BY_ENVIRONMENT:` and names the checks, before the planner runs.

### REQ-R5 (Event-driven) — Session start warns, never fixes
WHEN a Claude Code session starts in this repository, THE SYSTEM SHALL run the preflight in `--check-only` mode through a `SessionStart` hook in `.claude/settings.json` and print its human table; the hook SHALL NOT apply remediations and SHALL NOT block the session (exit 0 always, with the status in its output).

### REQ-R6 (Ubiquitous) — Every fault is classified before any policy is applied
THE SYSTEM SHALL classify every failure that stops a task into exactly one of: `environment` (toolchain/OS/filesystem: the preflight would fail), `api` (model API quota, session limit, outage: `agent()` returned `null` or a subagent reported `rate_limit_error`/`overloaded_error`/`authentication_error`), `transient` (a single network/registry blip that a bounded re-run clears), or `code` (a test, review or security finding about the change itself). Deterministic signatures SHALL classify first (exit codes, the strings `You have not agreed to the Xcode license agreements`, `ENOENT` on a toolchain binary, `EACCES` on `node_modules/.bin`, `ECONNREFUSED`/`ETIMEDOUT` to a registry or remote, the three API error names); agent judgment SHALL apply only to residual cases and SHALL be recorded as `classified_by: agent`. `code` failures SHALL flow through the normal reviewer/security/validator path and SHALL never be retried as if flaky.

*2026-09-25 amendment (specs/graph/J-jev-judgments.md REQ-J9):* between the signatures and agent judgment, a residual case MAY be classified by a confidence-gated Jev judgment, recorded as `classified_by: jev` with its confidence. Signatures still classify first. When Jev is unavailable, is not asked, or is below the confidence threshold, agent judgment applies exactly as above.

### REQ-R7 (Event-driven) — Agents stop and report on environment faults instead of improvising
WHEN a coder, tester, security or validator agent hits an `environment` or `api` signature, THE SYSTEM SHALL have that agent run `scripts/graph-preflight.sh` once; IF the status is not `ready`/`remediated`, THEN the agent SHALL write the blocked record (REQ-R9) via `scripts/graph-blocked.sh`, return `blocked_by_environment: {class, check_ids, evidence}` in its structured result with `passed: false` (tester) or the role's negative verdict, and stop. Every role schema in `sprint-cycle.js` SHALL carry the optional `blocked_by_environment` object; the role prompts SHALL state these rules under an `ENVIRONMENT RULES` heading placed before the existing `STALL RULES`. Additional evidence gathered by other means (for example a scratchpad harness when the suite cannot run) MAY be reported but SHALL NOT set `passed: true`.

### REQ-R8 (Event-driven) — The cycle halts cleanly on a fault and records it
WHEN any `agent()` in `sprint-cycle.js` returns `null` or a result carrying `blocked_by_environment`, THE SYSTEM SHALL stop the cycle at that stage (no later stage runs on a null or blocked input), `log()` the class and stage, and throw an error whose message begins `BLOCKED_BY_ENVIRONMENT:` followed by a JSON object `{cycleId, stage, taskId?, class, check_ids?, evidence}`. A `null` verdict from reviewer, security or validator SHALL be treated as this fault, never as "not approved".

### REQ-R9 (Ubiquitous) — The blocked record is human-actionable in under a minute
THE SYSTEM SHALL provide `scripts/graph-blocked.sh` that writes `.workflow/state/blocked.md` (and appends an `event: graph.blocked` line to `.workflow/state/events.jsonl`) containing, in this order: **What happened** (one line), **Class** (`environment|api|transient|needs_human`), **Impact** (cycle id, stage, task id, tasks completed / remaining), **Fix** (the exact command a human runs, or "none needed — resumes when the API is back"), **Resume** (the exact `/sprint --resume <cycleId>` invocation), **Evidence** (the failing check ids and the first 20 lines of the error), **Run record** (path to `run.json` and the Workflow journal). An agent returning `blocked_by_environment` SHALL write the record before returning. If `agent()` returns `null` or Workflow throws before a subagent can write it, `/sprint` SHALL write the record after catching `BLOCKED_BY_ENVIRONMENT:` and before reporting the fault to the human. The file SHALL be gitignored and SHALL be removed only by `/sprint --resume` after a passing preflight or by a human.

### REQ-R10 (Ubiquitous) — A durable run record makes resume mechanical
THE SYSTEM SHALL have `/sprint` write `.workflow/state/graph-cycles/<cycleId>/run.json` at launch (`{schema_version, cycleId, backlogItem, scriptPath, args, runId, journalPath, startedAt, status: running|blocked|completed|failed, resumedFrom?}`) and update `status`, `runId`, the complete args actually sent, and the new journal path on every resume or completion. A run-record update that changes a non-null `runId` SHALL reject missing `resumedFrom`, args, or new journal path. THE SYSTEM SHALL provide `scripts/graph-resume-args.mjs <cycleId>` that reads `run.json` and the run's `journal.jsonl` and prints the complete `args` object for a continuation — `backlogItem`, `cycleId`, `plan`, `priorBuildResults` (tasks whose tester result is journaled), `priorCoderResults` (tasks whose coder result is journaled but whose tester is not), `resumedFrom` — so that no field of a resume is ever typed by a human.

### REQ-R11 (Event-driven) — Resume is one command, gated on the same preflight
WHEN `/sprint --resume <cycleId>` is invoked, THE SYSTEM SHALL run the preflight; IF `ready`/`remediated`, THEN it SHALL derive the args with `scripts/graph-resume-args.mjs`, relaunch `sprint-cycle.js` with them (using the Workflow tool's `resumeFromRunId` when the script and prompts are unchanged, the derived args otherwise), remove any remaining non-`needs_human` blocked record, and update `run.json`; IF `needs_human`, THEN it SHALL refuse and print the blocked record. For a `needs_human` blocked record, the human SHALL perform the listed fix and remove `blocked.md` before invoking `/sprint --resume`; the full preflight SHALL then verify that the underlying fault is gone. The orchestrator session's autonomous loop MAY call `/sprint --resume` unattended for class `api` and `transient` only; class `needs_human` and `environment` faults whose remediation is not in the registry SHALL wait for the human's fix to be verified by preflight.

### REQ-R12 (Ubiquitous) — Tests are hermetic with respect to the toolchain
THE SYSTEM SHALL ensure no file under `tests/` or matching `*.test.*` spawns `git`, `brew`, `xcodebuild`, `xcrun`, `npm` or `npx` to obtain information derivable in-process; the repo root SHALL be derived from `import.meta.dirname` (Node ≥ 20.11; this checkout runs Node 26) or a `package.json` walk-up. The six `tests/graph-dashboard/*.test.mjs` files that call `execFileSync('git', ['rev-parse', '--show-toplevel'])` SHALL be converted, and a `try/catch` fallback to `process.cwd()` SHALL NOT be used as the fix.

### REQ-R13 (Unwanted behaviour) — Non-hermetic tests cannot land
IF a test file spawns one of the toolchain binaries in REQ-R12, THEN THE SYSTEM SHALL fail `npm test` at the DevOps root through a hermeticity check (`tests/hermeticity.test.mjs` or `scripts/check-test-hermeticity.sh` wired into the `test` script and CI) that names the file and line.

### REQ-R14 (Ubiquitous) — Environment faults are measured separately from change failures
THE SYSTEM SHALL add to `governance/graph/stability-dashboard.md` an "Environment faults" column (count, classes, time-to-resume) distinct from the change-failure columns, and `/sprint` SHALL append an `event: graph.environment_fault` line to `.workflow/state/events.jsonl` for every blocked record, so that DORA-style stability metrics are not moved by infrastructure outages.

### REQ-R15 (Unwanted behaviour) — The kill switch cannot be lifted by an agent
IF `.workflow/state/graph-halt` exists, THEN the preflight SHALL report `needs_human` for check `halt.absent` regardless of any other result, and no script, hook or subagent introduced by this spec SHALL remove that file; only the documented `/graph-resume` human action does.

### REQ-R16 (Ubiquitous) — Documentation matches the mechanism
THE SYSTEM SHALL update `slash-commands/universal/sprint.md` (preflight step, `--resume`), `governance/graph/role-mapping.md` (the `preflight` step and the blocked/resume lifecycle), `governance/graph/autonomy-config.yml` (a `resilience:` block naming the preflight, registry, blocked-record and run-record paths and the unattended-resume classes), and `CLAUDE.md`'s Hooks section (the `SessionStart` hook).

---

## Acceptance criteria

### AC-R1.1 (REQ-R1, R2)
**Given** a healthy checkout **When** `bash scripts/graph-preflight.sh` runs **Then** it exits 0, `.workflow/state/preflight.json` parses with `status: "ready"` and at least eight `checks` entries, and the human table shows one ✓ per check.

### AC-R1.2 (REQ-R1)
**Given** `PATH` altered so `git` is a script that prints `You have not agreed to the Xcode license agreements` and exits 69 **When** the preflight runs with `--check-only` **Then** it exits 20 and `checks[id=git.runs].status` is `fail` with that evidence string.

### AC-R3.1 (REQ-R3)
**Given** the AC-R1.2 setup, a temporary first-on-PATH directory, and the Command Line Tools git present **When** the preflight runs without `--check-only` **Then** it exits 10, `checks[id=git.runs].status` is `fixed`, the shim exists in that directory with the registry's `apply` command recorded, and running the registry's `revert` removes it.

### AC-R3.2 (REQ-R3)
**Given** a registry entry with `needs_sudo: true` **When** the preflight loads the registry **Then** it exits 2 and reports the entry as invalid (sudo remediations are not representable).

### AC-R4.1 (REQ-R4)
**Given** `.workflow/state/graph-halt` present **When** `/sprint <item>` is invoked **Then** no Workflow is launched, the output names `halt.absent`, and `blocked.md` is not overwritten if it already exists.

### AC-R4.2 (REQ-R4, R8)
**Given** a test double of `sprint-cycle.js` whose preflight agent returns `status: "needs_human"` **When** the workflow runs **Then** it throws before the planner stage with a message starting `BLOCKED_BY_ENVIRONMENT:` whose JSON parses and contains `stage: "preflight"`.

### AC-R5.1 (REQ-R5)
**Given** the `SessionStart` hook wired **When** the hook script is invoked with the preflight forced to fail **Then** it prints the human table with the failing check and exits 0.

### AC-R6.1 (REQ-R6)
**Given** a fixture of ten captured error outputs (three Xcode-license, two `ENOENT` toolchain, one `EACCES` `.bin`, two API error names, two genuine test failures) **When** the classifier (`scripts/graph-classify-fault.mjs` or the equivalent function) runs on each **Then** all ten receive the expected class and `classified_by: signature`.

### AC-R7.1 (REQ-R7)
**Given** the tester prompt in `sprint-cycle.js` **When** it is read **Then** an `ENVIRONMENT RULES` heading precedes `STALL RULES`, and every role schema declares `blocked_by_environment` with `class`, `check_ids`, `evidence` properties.

### AC-R8.1 (REQ-R8)
**Given** a test double where the reviewer agent returns `null` **When** the workflow runs **Then** the security and validator stages do not run and the thrown message contains `"class":"api"` and `"stage":"reviewer"`.

### AC-R9.1 (REQ-R9)
**Given** `bash scripts/graph-blocked.sh --cycle c7 --stage tester --task T3 --class environment --checks git.runs --evidence-file e.txt` **When** it runs **Then** `.workflow/state/blocked.md` contains the seven headings in order, the Resume line is exactly `/sprint --resume c7`, `events.jsonl` gained one `graph.blocked` line, and `git check-ignore .workflow/state/blocked.md` succeeds.

### AC-R10.1 (REQ-R10)
**Given** cycle 6's real `journal.jsonl` for run `wf_9f295fe7-e33` (no planner result; tester T7 and coder/tester pairs T8–T13 journaled) and a project-local `run.json` fixture carrying the earlier plan T1–T13, completed coder/tester results T1–T6, and coder result T7 **When** `node scripts/graph-resume-args.mjs <cycleId>` runs **Then** the printed args contain that plan, `priorBuildResults` with T1–T13, an empty `priorCoderResults` array, and `resumedFrom: "wf_9f295fe7-e33"`.

### AC-R11.1 (REQ-R11)
**Given** `blocked.md` with class `needs_human` and a failing preflight **When** `/sprint --resume` is invoked **Then** nothing is launched and `blocked.md` is unchanged; **Given** the human performed the listed fix and removed `blocked.md`, and preflight is `ready` **When** `/sprint --resume` is invoked again **Then** the Workflow launches with the derived args and `run.json` records those args and the new journal path. For any remaining non-`needs_human` blocked record, `/sprint --resume` removes it only after a passing preflight and successful launch.

### AC-R12.1 (REQ-R12)
**Given** `PATH` with no `git` at all **When** `node --test tests/graph-dashboard/` runs **Then** every test that passed before still passes (root resolved from `import.meta.dirname`).

### AC-R13.1 (REQ-R13)
**Given** a temporary test file containing `execFileSync('git', ['rev-parse'])` **When** the hermeticity check runs **Then** it exits non-zero naming that file and line; **Given** the file removed **Then** it exits 0.

### AC-R14.1 (REQ-R14)
**Given** the dashboard file **When** parsed **Then** the cycle table has an "Environment faults" column and the cycle-6 row records the three faults from the Context table.

### AC-R16.1 (REQ-R16)
**Given** the four documents in REQ-R16 **When** grepped **Then** each names `scripts/graph-preflight.sh`, and `autonomy-config.yml` parses with a `resilience.unattended_resume_classes` list equal to `[api, transient]`.

---

## Traceability

| REQ | Removes which human intervention | Research anchor |
|---|---|---|
| R9, R10, R11 | hand-assembled resume arguments (twice this week) | Temporal/LangGraph/Inngest persistence; Ewaschuk; Strömberg |
| R1–R5 | discovering a dead toolchain mid-run | `brew doctor`/`flutter doctor`; Kubernetes readiness vs liveness |
| R6, R7, R8 | reading logs to tell outage from defect; nulls silently read as verdicts | Google flaky-test rule; Buildkite exit −1; Anthropic API errors |
| R12, R13 | the test suite dying with the toolchain | Bazel hermeticity; Node `import.meta.dirname` |
| R14 | metrics moved by outages | DORA 2023 recovery-time definition |
| R15 | none — keeps the kill switch meaningful | OWASP Agentic Top 10 2026 |
