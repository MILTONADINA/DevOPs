# Graph / Area M: The Masterpiece Standard for the DevOPs Graph

**Spec ID**: graph/M-masterpiece-standard
**Status**: draft (awaiting owner approval; see Owner questions in `governance/graph/masterpiece-roadmap.md`)
**Last updated**: 2026-09-25
**Owner**: miltonadina
**Reviewers**: miltonadina (orchestrator session: Claude Opus 5.5)

---

## Context

The owner defines an "absolute masterpiece" as the standard BrightPath sets out in `docs/architecture/MASTERPIECE_WORKFLOW.md` and `docs/architecture/ENGINEERING_GRAPH.md`. It has six parts: nothing certifies itself, evidence is bound to its source, work is scheduled by a graph, convergence needs a zero anchor plus two repeats, a live read-only dashboard exists, and security, review and pentest run as workflows. The DevOPs graph must meet that standard and then be installed on BrightPath. Auto-memory has long cited this file (`specs/graph/M-masterpiece-standard.md`), but it did not exist until now (`specs/graph/` held only `J-jev-judgments.md` and `R-resilience.md`).

**Source of the standard.** All BrightPath files were read at HEAD `6480978a0` on branch `chore/masterpiece-r124`. That working tree had 28 uncommitted changes, so any `ENGINEERING_GRAPH.md` citation after line 408 is 10 lines higher there than at HEAD.

| BrightPath source | What DevOPs takes from it |
|---|---|
| `MASTERPIECE_WORKFLOW.md:11-33` | Specification integrity comes before implementation conformance. "A perfectly implemented incorrect specification is a failed outcome." |
| `MASTERPIECE_WORKFLOW.md:183-202`, `scripts/check-pr-spec-contract.mjs:49-53, 314-367` | The 8-link traceability chain. BrightPath enforces only 7 links per PR because `LIFECYCLE_KEYS` starts at `requirement`. DevOPs also enforces link 1, the approved outcome (REQ-M8). |
| `MASTERPIECE_WORKFLOW.md:204-216`, `graph_git_publication.py:752-776` | The decision boundary. Owner approvals are authenticated, and an unavailable authority means owner-gated, never invented. |
| `MASTERPIECE_WORKFLOW.md:125-127`, `scripts/masterpiece/loop.py:1061-1092, 2383-2501`, INV-VERIFY-015 | INDETERMINATE: failed, partial, killed or ambiguous work never counts as clean. |
| `MASTERPIECE_WORKFLOW.md:262-297`, `scripts/masterpiece/control_plane.py:25761-25951` | Frozen convergence: the anchor does not count, exactly 2 fresh-process zero repeats on the unchanged anchor, a third repeat is refused, and any change resets the count. |
| `MASTERPIECE_WORKFLOW.md:356-371`, `lifecycle-contract.json:230-237` | Completion states stay distinct, and the sweep counter proves only CODE-CONVERGED. |
| `ENGINEERING_GRAPH.md:3-37`, `engineering_graph.py:102-153` (`:121` "self-declared completion is not evidence") | The graph is the primary scheduler. It has no `status`/`done` field, and fingerprints invalidate dependents. |
| `ENGINEERING_GRAPH.md:460-530`, `graph_dashboard.py:296-297, 388-412` | The observer dashboard: anything unobserved is `NOT_OBSERVED` or stale, and a stored PASS is never shown as current approval. |
| `scripts/ci-local-gates.sh:1472-1516`, `check-spec-traceability.mjs:1-35` | No gate without a clause. Every clause names its enforcement, and enforcement never regresses. |
| `.github/workflows/branch-protection-check.yml:88-153` | Required status contexts, re-asserted against the live ruleset. |
| `security.yml:39-160`, `nuclei-scan.yml:108-125`, `zap-scan.yml:1-47`, `.claude/skills/pentest/SKILL.md:1-44` | Scans assert that they scanned something. DAST fails loudly without a report or target. An unavailable pentest target is INDETERMINATE. |
| `check-masterpiece-lifecycle.mjs:86-110, 313-323, 387-419` | Tool-parity adapters and the ban on skip lists. |

**Where DevOPs stands today** (read-only maps, 2026-09-25, branch `feature`). Most of what the graph promises is enforced only by prompt:

- `readyForPR` is `validator.signed_off && failedTasks.length === 0` (`.claude/workflows/sprint-cycle.js:317`). The reviewer and security verdicts count only through the validator prompt (`:298`).
- A null agent result defaults to fault class `api` (`:47`), and `api` is one of the classes allowed to resume unattended (`governance/graph/autonomy-config.yml:67`).
- Planner ambiguities are logged and then ignored (`:139`).
- The ban on commit and push is prompt text (`:106`, `:174`; `governance/graph/role-mapping.md:98-123`).
- `main` has no required status checks and requires 0 approvals (live `gh api`, 2026-09-25).
- The Semgrep CI job crashes on every run (`ValueError: invalid rule severity value: MEDIUM`) yet reports success (`.github/workflows/security-scan.yml:56-65`); fixed on 2026-09-25 in PR #178 (`specs/security/ci-semgrep-scan.md`). `docs/LAUNCH_READINESS.md:49` still calls it "green".
- The claim step in CI validates nothing because `.workflow/proofs/` is gitignored (`.gitignore:5`, PB-60).
- No test covers `deploy-gate.sh` or `block-sealed-refs.sh`, and both hooks can be bypassed (probe matrix in the map).
- There is no graph data structure, no convergence rule and no completion-state vocabulary.

This spec closes those gaps in proportion to the problem. It adopts BrightPath's guarantees, not its weight: no 9,180-node projection, no matrix fingerprint and no TCB machinery.

## Constraints the design must respect

- **Workflow scripts have no filesystem, timers or Node APIs** (`specs/graph/R-resilience.md` Constraints). Anything that re-executes a proof, reads a journal or writes a record is an orchestrator-side script run by `/sprint` after the Workflow returns. It is never a schema field that an agent fills in about itself.
- **Hooks see only the literal command text.** PreToolUse is wired only for `Bash` today (`.claude/settings.json:24-40`). The GitHub MCP write tools (`push_files`, `create_or_update_file`, `delete_file`, `create_pull_request`, `merge_pull_request`) are live in this environment and ungated. Wrapping a command in a script file gets past any text-matching hook. That limit is documented; it is not claimed as fixed.
- **It is unverified whether PreToolUse hooks fire inside Workflow-spawned subagents.** Every requirement below that relies on a hook inside a cycle depends on the one-time proof in AC-M17.1.
- **`.workflow/state/` is gitignored** (`.gitignore:4`), so CI can never see run records, events or approval markers. Checks on those run locally, in preflight or under `/sprint`.
- **`gh` runs with the owner's token,** and any agent with Bash can use it. A PR comment or review posted through `gh` therefore cannot tell the owner apart from an agent. Approvals must be signed out of band (REQ-M15).
- **Branch protection on `main` has `enforce_admins: false`.** Even with required contexts enabled, an admin token can merge past them.
- **Two GitHub Actions facts.** Exit code 78 does not produce a neutral result, and a job skipped by an `if:` condition satisfies a required context. A skip must therefore never sit on a required context.
- **Money.** API spend is de-funded, so no requirement may run a paid judged evaluation or a paid red-team without the owner's explicit approval.
- **Unchanged from earlier specs.** The production-deploy and billing four-eyes rules and the `graph-halt` kill switch stay as they are (`autonomy-config.yml`, REQ-R15). This spec tightens how they are enforced; it never loosens them.
- **BrightPath is read-only from this repository.** `engineering_graph.py` refuses any `--root` other than its own (BP `engineering_graph.py:455-456`). Vendored skills must match BrightPath's 14 classified adapters (BP `check-masterpiece-lifecycle.mjs:92-110, 185-205`). Hook commands added to BrightPath's `settings.json` become enforcement paths that need clause citations (BP `check-spec-traceability.mjs:522-531`).

## Out of scope and explicit omissions

**Out of scope:**
- BrightPath's 9,180-node graph projection, its matrix fingerprint, its TCB assumption set and its evidence-dir device/inode binding (BP `ENGINEERING_GRAPH.md:124-139`). The evidence-dir binding is deferred as minor.
- **Release, production readiness and aftercare** (BP phases 9-11: staging rehearsal, restore proof, SLOs, canary, post-deploy observation). No production deployment topology exists (`plan.md` §4; ADR-0020 retired the hosted Supabase project). Until one exists, `production_complete` and `release_ready` are unreachable by rule (REQ-M10) instead of being specified in prose.
- **Two-axis reachability** (BP INV-VERIFY-058). DevOPs ships no dormant, mounted-but-disabled production code paths today. Deferred until a deployment exists.
- **Verifier calibration with planted canaries** (BP `loop.py` confirmation floor of at least 70%). This is deferred, because a calibrated reviewer/security run needs funded API spend. It is listed as a deferred roadmap item, not dropped.

**Explicit omissions (decided, not silent):**
- **BrightPath's twelve always-on questions (MP-Q-001..012) and its 11-phase exit-evidence model (MP-PHASE-01..11, MP-AC-001..017) are not adopted.** In BrightPath both are enforced only as wording parity (BP `check-masterpiece-lifecycle.mjs:36-63`), and recording the answers is prose. DevOPs puts the mechanical subset into code instead: approved-spec binding (REQ-M8), ambiguity blocking (REQ-M7), INDETERMINATE (REQ-M3) and completion states (REQ-M10). The owner is asked to confirm this omission.
- **Three proposals from the gap analysis were replaced by lighter mechanisms:**
  - A per-requirement Blueprint ledger became section-level dispositions on work-graph nodes (REQ-M12).
  - A validator-reported `spec_integrity` verdict became owner approval of the spec plus a lint (REQ-M8), because an agent's boolean about spec correctness would be self-certification.
  - A separate authority-order file became one precedence line in `AGENTS.md`, with conflicts routed through the ambiguity block (REQ-M7).

## Actors and data

- **Primary actors:** `/sprint` (the orchestrator session); the `sprint-cycle.js` agents (preflight, planner, coder, tester, reviewer, security, validator); the PreToolUse hooks; CI (`ci.yml`, `security-scan.yml`); the owner (the only approver).
- **Data:**
  - Local: `.workflow/state/{preflight.json, blocked.md, events.jsonl, graph-halt, graph-approvals/, graph-cycles/<cycleId>/run.json, convergence/<scope>.json}`.
  - Committed: `.workflow/proofs/` (or its index, per the owner's PB-60 decision), `governance/graph/work-graph.json`, `governance/graph/allowed_signers`, `governance/enforcement-baseline.json`, `governance/scan-floors.yml`.
  - No PII. No secret is ever written. An approval signature is public-key verifiable.
- **Compliance scope**: [x] none.

---

## Functional requirements (EARS)

Every REQ carries two lines, as this spec requires of every spec (REQ-M8 and REQ-M20). **Enforced by** names the mechanism. **Falsified by** names the observation that would prove the guarantee absent.

### REQ-M1 (Ubiquitous): Readiness is computed in code from every verdict
THE SYSTEM SHALL compute `readyForPR` in `sprint-cycle.js` as the conjunction of all of these:
- `validator.outcome === 'PASS'`
- `reviewer.approved === true` with no BLOCKER listed
- `security.outcome === 'PASS'`
- every tester `outcome === 'PASS'`
- no stage INDETERMINATE (REQ-M3)

No verdict may count only because a prompt tells another agent to weigh it.
**Enforced by:** code in `sprint-cycle.js` (replacing `:317`); tests in `tests/graph-resilience/workflow-faults.test.mjs`.
**Falsified by:** a fake-agent run with the reviewer returning `approved:false` (or security `FAIL`) and the validator `PASS` that yields `readyForPR: true`.

### REQ-M2 (Event-driven): The orchestrator re-executes proofs and scanner runs; agents do not self-report them
WHEN a Workflow cycle returns, `/sprint` SHALL run `scripts/graph-rerun-proofs.mjs --cycle <id>`. The script SHALL:
- read the tester results (`proof: {command, exit_code}`, required in the tester schema) and the security results (`scans: [{tool, command, exit_code, scanned_files}]`, required in the security schema) from the run's `journal.jsonl`;
- re-execute each command from the project root;
- exit non-zero if any exit code differs, or if any scanner reports `scanned_files` below the floor in `governance/scan-floors.yml`.

A non-zero exit SHALL set `run.json` status to `failed` (REQ-M6).
**Enforced by:** the orchestrator script plus a `/sprint` runbook step. The script's own tests are in `tests/graph-resilience/rerun-proofs.test.mjs`.
**Falsified by:** a journal fixture whose tester claims `exit_code: 0` for a command that exits 1, or whose security scan reports 0 files, and the script exits 0.

### REQ-M3 (Ubiquitous): INDETERMINATE is a first-class outcome and never counts as clean
THE SYSTEM SHALL add a required field `outcome: enum [PASS, FAIL, INDETERMINATE]` to the tester, security and validator schemas. The existing booleans are kept for resume compatibility (`tests/graph-resilience/resume-args.test.mjs`). A disagreement between a boolean and its `outcome` SHALL be treated as INDETERMINATE. THE SYSTEM SHALL add `indeterminate` to the run-record status list (`scripts/graph-run-record.mjs:30`). IF any stage is INDETERMINATE, THEN `readyForPR` SHALL be false and the cycle outcome SHALL say INDETERMINATE, never "not approved".
**Enforced by:** code and schema in `sprint-cycle.js` and `graph-run-record.mjs`; tests.
**Falsified by:** a fixture with a tester result `{passed: true, outcome: 'INDETERMINATE'}` that yields `readyForPR: true`.

### REQ-M4 (Unwanted behaviour): An unknown fault is never reclassified as resumable
IF `agent()` returns `null` or a `blocked_by_environment` object without a class, THEN `stopIfBlocked` SHALL assign class `needs_human`, not `api` (`sprint-cycle.js:47`). `BLOCKED_SCHEMA.class` (`:26`) SHALL be `enum [environment, api, transient, needs_human]`. A result carrying any other class SHALL be treated as `needs_human`.
**Enforced by:** code in `sprint-cycle.js`; tests.
**Falsified by:** a fake run where the reviewer returns `null` and the thrown `BLOCKED_BY_ENVIRONMENT` JSON contains `"class":"api"`.

### REQ-M5 (Event-driven): Launch and unblock are bound to a fresh preflight
WHEN `graph-run-record.mjs launch` or `update --clearBlocked true` runs, THE SYSTEM SHALL refuse unless all of the following hold:
- `.workflow/state/preflight.json` has `status` of `ready` or `remediated`;
- its `git_sha` equals `git rev-parse HEAD`;
- its `ran_at` is no more than 15 minutes old;
- for `clearBlocked`, its `ran_at` is newer than `blocked.md`'s mtime.

Today `clearBlocked` checks only `status` (`scripts/graph-run-record.mjs:51-54`), and `launch` does not read the preflight at all.
**Enforced by:** code in `graph-run-record.mjs`; tests in `tests/graph-resilience/run-record.test.mjs`.
**Falsified by:** a launch that succeeds with a passing `preflight.json` whose `git_sha` is a different commit.

### REQ-M6 (Event-driven): Cycle status and history are derived from the journal, not asserted by the caller
WHEN `graph-run-record.mjs update --status completed|failed|indeterminate` runs, THE SYSTEM SHALL read the Workflow's final result for `runId` from its `journal.jsonl` and derive the status from it:
- `completed` only if `readyForPR` is true and REQ-M2's rerun passed;
- `indeterminate` if any stage was INDETERMINATE;
- `failed` otherwise.

It SHALL refuse a caller-supplied status that disagrees with the derived one. It SHALL append the cycle's row to `governance/graph/stability-dashboard.md` from `run.json` plus the journal outcome, and refuse a duplicate `cycleId`. Today the row is written by hand (`slash-commands/universal/sprint.md:87-88`).
**Enforced by:** code in `graph-run-record.mjs`; tests.
**Falsified by:** `update --status completed` accepted for a run whose journal result has `readyForPR: false`, or a second row for the same `cycleId`.

### REQ-M7 (Unwanted behaviour): Material ambiguity and source conflicts stop the cycle
IF the planner returns a non-empty `ambiguities[]` or `conflicts[]`, THEN `sprint-cycle.js` SHALL throw `AMBIGUITY_BLOCK:` followed by the items as JSON, before Build. The only exception: every item appears verbatim in `args.acknowledgedAmbiguities`.
- `/sprint` SHALL populate that list only from the owner's answer, recorded verbatim in `run.json` (`acknowledgements: [{item, answer, at}]`), and SHALL write a `needs_human` blocked record on the throw.
- The planner schema SHALL add `conflicts: [{higher, lower, clause}]`.
- `AGENTS.md` SHALL carry one precedence line: owner decision > law/safety > approved spec > ADR/AC > plan > code.

**Enforced by:** code in `sprint-cycle.js` (replacing the log-only `:139`); the `graph-run-record.mjs` acknowledgement field; tests.
**Falsified by:** a fake planner returning one ambiguity and the coder stage running without a matching acknowledgement.

### REQ-M8 (Event-driven): Every cycle is bound to an approved, falsifiable spec (all 8 chain links, link 1 included)
WHEN `graph-run-record.mjs launch` runs, THE SYSTEM SHALL require `--spec-ref specs/<path>.md#<anchor>` and SHALL refuse unless:
- the spec's `**Status**:` line matches `^approved`;
- the anchor exists;
- every `REQ-` heading in that spec has at least one `AC-` that references it, and a `Falsified by:` line.

`sprint-cycle.js` SHALL take `args.specRef`. The planner schema SHALL require `tasks[].ac_ids` (non-empty, each present in the spec). The claim schema SHALL require `outcome_ref` (the approved spec anchor) and `decision_ref` (an ADR path or `{na_reason, approver}`) for type `implementation`. It SHALL require `signal {metric, threshold}` and `recovery {mode, doc}` only for types `deploy` and `migration`. `scripts/lint-spec-status.mjs` in `ci.yml` SHALL fail on any Status value outside `draft|approved|superseded`.
**Enforced by:** code in `graph-run-record.mjs` and `sprint-cycle.js`; `claim-validator.ts`; the CI lint.
**Falsified by:** a launch that succeeds against a `draft` spec, or against an approved spec with a REQ that has no AC.

### REQ-M9 (Ubiquitous): Claims are schema-validated, committed, RED/GREEN, and never vacuous
THE SYSTEM SHALL meet each of the following:
- `verification/claim-validator.ts` loads and enforces `verification/claim-schema.yml` (enum, pattern, min/maxLength, required). Today it never reads the schema, despite `claim-validator.ts:5`.
- The validator checks that the `spec_ref` file and anchor exist.
- The validator exits non-zero when invoked with `--claim <id>` for a missing claim, and when invoked with `--all` on an empty set.
- The proof set is committed per the owner's PB-60 decision (the YAMLs, or `proofs/index.jsonl` of `{id, sha, sha256}`), so CI validates an exact, non-empty set.
- Type `implementation` or `test` requires `proof.red: {sha, exit_code != 0}`. The validator re-runs the RED at that sha in a temporary worktree when not `--no-rerun` (locally only, not in CI).
- The tester returns a `claim_id`, and `/sprint` runs `tsx verification/claim-validator.ts --claim <id>` after the cycle; a non-zero exit sets `run.json` to `failed`.

**Enforced by:** `claim-validator.ts`; the `ci.yml` validate job; the `/sprint` post-cycle step.
**Falsified by:** a claim with `description` longer than 280 characters, or `spec_ref` pointing at a missing file, passing; or CI's claim step printing "No claim files to validate." and exiting 0.

### REQ-M10 (Ubiquitous): Completion states are a closed vocabulary, never estimated upward
THE SYSTEM SHALL add `state: enum [implemented, verified, code_converged, release_ready, fixed_not_live, production_complete]` to `claim-schema.yml`. The order is implemented < verified < code_converged < release_ready < production_complete. `fixed_not_live` means the repository work is verified but an owner action is pending; it is never called deployed. Underscores are used in code (BrightPath's doc uses hyphens). The validator SHALL refuse:
- `code_converged` without a `graph-converge.mjs status` exit 0 for the claim's scope (REQ-M11);
- `production_complete` without a deploy proof `{url, sha, observation_window}`;
- `release_ready` while any in-scope work-graph node is `CANDIDATE` or `CONFLICT` (REQ-M12).

"Masterpiece" without a qualifier SHALL mean `production_complete`. The sweep counter proves only `code_converged`. `scripts/lint-readiness-claims.mjs` SHALL fail when any of the literal state tokens, or the status column of the version tables in `docs/LAUNCH_READINESS.md` or `SHIP_BLOCKERS.md`, lacks a cited claim id whose state supports it. It deliberately does not match free prose such as "live dashboard".
**Enforced by:** schema, validator and CI lint.
**Falsified by:** a claim with `state: production_complete` and no deploy proof passing; or `LAUNCH_READINESS.md:241` still asserting production-complete with no claim id.

### REQ-M11 (Ubiquitous): Frozen convergence is a zero anchor plus exactly two fresh-process zero repeats
THE SYSTEM SHALL provide `scripts/graph-converge.mjs freeze|record|status --scope <s>`.
- **freeze** writes `.workflow/state/convergence/<scope>.json` = `{anchor_sha: HEAD, inputs_sha256, anchor_run_id, repeats: 0}`.
  - `inputs_sha256` is a hash over the scope's spec set, the `sprint-cycle.js` prompts and schemas, and the pinned tool versions.
  - freeze requires that the anchor run's journal shows zero findings.
  - The anchor never counts as a repeat.
- **record --run-id <wf>** derives the findings count from that run's `journal.jsonl` under `~/.claude/projects/<root>` (it never takes a count as an argument). It increments `repeats` only if all of these hold:
  - HEAD and `inputs_sha256` are unchanged;
  - the run id is distinct from the anchor and from earlier repeats (a fresh process);
  - the run started after the anchor;
  - the count is 0.
  Otherwise it resets `repeats` to 0 and invalidates the anchor.
- A third repeat SHALL be refused.
- **status** exits 0 only when `repeats == 2`.

The claim is conformance to the frozen inputs only, not absence of defects.
**Enforced by:** code in `graph-converge.mjs`; tests covering every reset branch.
**Falsified by:** `status` exiting 0 after a repeat recorded on a changed HEAD, after the same run id recorded twice, or after a journal with one finding.

### REQ-M12 (Ubiquitous): The dependency graph schedules work
THE SYSTEM SHALL provide `governance/graph/work-graph.json` and `scripts/graph-next.mjs`.
- **Nodes:** spec ACs, backlog items, gates, and one node per `blueprint.md` section heading. Each blueprint node has `disposition: ACCEPTED|IMPLEMENTED|SUPERSEDED|CONFLICT|OUT_OF_SCOPE|CANDIDATE`; OUT_OF_SCOPE needs `{reason, approver}`.
- **Edges:** `requires` only.
- **Forbidden:** any `status` or `done` field.
- `graph-next.mjs` SHALL:
  - reject cycles, dangling edges and `status`/`done` fields;
  - fail when a `blueprint.md` heading has no node, or when any node is `CONFLICT`;
  - print the frontier.
- `graph-run-record.mjs launch` SHALL refuse a backlog item that is not on the frontier.
- **Second slice**, after REQ-M9 commits claims: node state is derived only from claims validated at the node's current source fingerprint, so a spec change invalidates dependents.

**Enforced by:** `graph-next.mjs` run in `ci.yml` validate and by `launch`; tests.
**Falsified by:** a launch that succeeds for an item whose `requires` predecessor has no validated claim; or a graph containing `"done": true` that validates.

### REQ-M13 (Ubiquitous): CI results can block merges, and drift is detected
THE SYSTEM SHALL keep `governance/required-checks.yml`, the list of the context names the owner requires on `main`. `scripts/graph-preflight.mjs` SHALL add check `branch.protection`, which uses the owner's local `gh` to read `branches/main/protection`. It fails with `needs_human` when any listed context is missing or `required_approving_review_count < 1`. Applying the ruleset is an owner action. DeepTeam and Claude Security Review SHALL never be listed as required contexts, because a skip would satisfy them.
**Enforced by:** the preflight check (it blocks `/sprint` launch, REQ-M5) plus the owner's GitHub setting.
**Falsified by:** preflight reporting `ready` while `gh api .../required_status_checks` returns 404.

### REQ-M14 (Unwanted behaviour): A scan that scanned nothing never passes
IF a security scan in CI exits abnormally, reports rule or parse errors, or scans fewer files than its floor in `governance/scan-floors.yml`, THEN the job SHALL fail. Specifically:
- Semgrep SHALL run as a pinned `semgrep scan --json --error`, piped to `scripts/assert-scan.mjs`, which fails on a non-empty `errors[]` or on `paths.scanned` below the floor. This replaces `returntocorp/semgrep-action@713efdd` at `security-scan.yml:56-65`.
- `scripts/run-redteam.sh` SHALL exit non-zero, not 0 with `SKIPPED.md` (`:51-67`), on push-to-main or schedule when it was meant to run and has no key or no target. Skips on PR path filters remain skips and are not required contexts.

**Enforced by:** CI plus `assert-scan.mjs`; tests with a crashed-scan JSON fixture.
**Falsified by:** a Security scan run on `main` that concludes success while its log contains `invalid rule severity value` or `RED-TEAM GATE SKIPPED`.

### REQ-M15 (Ubiquitous): Human-only approvals are signed out of band
THE SYSTEM SHALL accept a deploy, billing, halt-lift, blocked-clear or ambiguity-acknowledgement marker only if:
- it carries a detached signature that `ssh-keygen -Y verify` accepts against committed `governance/graph/allowed_signers`, namespace `devops-graph`;
- the signed payload is `{cycle, sha, action, approver, ts}` with `sha == HEAD` and `cycle` equal to the running cycle;
- for billing, two signatures come from distinct keys.

The signing key SHALL be one an agent cannot use: a FIDO `sk-` key, or a passphrase key not loaded in `ssh-agent`. Free-text approver strings (`deploy-gate.sh:164-173`) and `gh`-posted comments SHALL NOT count as approval.
**Enforced by:** `deploy-gate.sh`, `graph-run-record.mjs` and `graph-preflight.mjs` (halt), each calling `ssh-keygen -Y verify`; tests with a throwaway test key.
**Falsified by:** a marker whose content is `{}`, or one with a valid signature over a different `sha`, admitting a deploy-shaped command.

### REQ-M16 (Ubiquitous): Gate hooks are hardened and regression-tested
THE SYSTEM SHALL add `tests/hooks/deploy-gate.test.mjs` and `tests/hooks/block-sealed-refs.test.mjs` to `npm test`. They are built from the 2026-09-25 probe matrix, and each bypass is committed as a failing case before its fix. `deploy-gate.sh` SHALL:
- check `graph-halt` before its pre-filter (`:99-106`; `graph-halt.md:9`);
- match `gh pr merge`, `gh release`, `supabase db push`, `git -C <dir> …`, tag pushes by name, and `:ref`/`+ref` refspecs;
- take `CYCLE_ID` from the single `running` `graph-cycles/*/run.json`, failing closed when there are zero or several (today it falls back to `current`, `:30`);
- when a push has no upstream, diff against `origin/main`, failing closed if that cannot be resolved (`:148-157`).

`block-sealed-refs.sh` SHALL match refspec deletions, `update-ref` and `git -C`, and SHALL NOT block inert text such as `echo git tag -d v0.2.0`. The script-file-wrapper bypass SHALL be documented as a known limit.
**Enforced by:** the hooks plus `tests/hooks/*`.
**Falsified by:** any row of the probe matrix exiting 0 when it should block, or exiting 2 for `echo git tag -d v0.2.0`.

### REQ-M17 (Unwanted behaviour): No autonomous stage, commit, push, merge or PR while a cycle runs; one cycle at a time
IF any `.workflow/state/graph-cycles/*/run.json` has status `running`, THEN THE SYSTEM SHALL block:
- `git (add|commit|push|tag)` and `gh pr (create|merge)` in `deploy-gate.sh`;
- through a new PreToolUse matcher, the GitHub MCP write tools `push_files`, `create_or_update_file`, `delete_file`, `create_pull_request` and `merge_pull_request`.

The orchestrator commits only after `update` has derived the status (REQ-M6). `graph-run-record.mjs launch` SHALL refuse while another record is `running`; this is the single-flight rule, because the tester prompt tolerates concurrent tree changes (`sprint-cycle.js:203`). A human clear path for a killed run left `running` SHALL be documented. Before this requirement is relied on, a one-time proof SHALL establish whether PreToolUse hooks fire inside Workflow subagents. If they do not, the coder and tester `agent()` calls SHALL pass `isolation: 'worktree'`.
**Enforced by:** hook, matcher and `launch` code; `tests/hooks/cycle-commit-lock.test.mjs`; the recorded subagent-hook proof claim.
**Falsified by:** a `git commit --allow-empty` issued by a Workflow subagent while a run is `running` succeeding.

### REQ-M18 (Unwanted behaviour): Gate configuration and gate state are not agent-writable
IF a Write or Edit targets `hooks/`, `.claude/settings.json`, `.claude/workflows/`, `.workflow/state/graph-approvals/`, `.workflow/state/graph-halt`, `.workflow/state/blocked.md` or `governance/graph/allowed_signers`, THEN a PreToolUse `Write|Edit` hook SHALL deny it. `deploy-gate.sh` SHALL deny Bash `rm`, `mv`, `cp`, `tee` or redirections onto those paths. Owner edits go through a signed marker (REQ-M15) or are made outside the agent session. Hook edits take effect in the running session (CLAUDE.md), so this is what keeps an agent from disabling a gate mid-session.
**Enforced by:** the new hook plus a `deploy-gate.sh` extension; `tests/hooks/protected-paths.test.mjs`.
**Falsified by:** an Edit to `hooks/universal/pre-tool/deploy-gate.sh` from an agent session succeeding.

### REQ-M19 (Ubiquitous): The gate audit trail is tamper-evident
THE SYSTEM SHALL give each line appended to `.workflow/state/events.jsonl` a `prev_sha256` field chaining it to the previous line. The dashboard and preflight SHALL verify the chain, and a break SHALL show as `TAMPERED` in the dashboard and cause `needs_human` in preflight.
**Enforced by:** the shared append helper used by the hooks and `graph-blocked.sh`; a preflight check; tests.
**Falsified by:** a truncated or edited middle line not detected.

### REQ-M20 (Ubiquitous): No gate without a clause, and no clause without real enforcement
THE SYSTEM SHALL require every `REQ-` in `specs/graph/` and `specs/security/`, and every row of the tier table in `docs/SECURITY.md`, to carry `Enforced by:`. That line must resolve to an existing test file, a `ci.yml` job id, a hook actually wired in `.claude/settings.json`, `PROCESS`, or `UNENFORCED`. `scripts/check-enforcement.mjs` in `ci.yml` validate SHALL fail on an unresolvable reference. It SHALL also fail when a REQ recorded in `governance/enforcement-baseline.json` as enforced becomes `UNENFORCED`, since the baseline only ratchets. The reverse direction, that every hook and job is cited by a REQ, is deferred.
**Enforced by:** CI checker plus committed baseline; tests.
**Falsified by:** `docs/SECURITY.md:12` claiming a gitleaks post-tool hard block while `gitleaks-scan.sh` is unwired, and the check passing.

### REQ-M21 (Ubiquitous): Closures and freshness markers cite evidence
THE SYSTEM SHALL fail a CI lint (`scripts/lint-closures.mjs`) when a `.workflow/state/polish-backlog.md` or `SHIP_BLOCKERS.md` item marked `CLOSED` does not cite a commit or PR plus a claim id present in the committed proof set (REQ-M9). This applies only to committed copies; the polish backlog is checked locally when it is gitignored. `hooks/universal/post-tool/sync-lr-refined-date.sh` SHALL bump "Last refined" only when invoked by `/launch-readiness` after re-derivation, not on every `plan.md` edit.
**Enforced by:** CI lint; the hook change; tests.
**Falsified by:** a CLOSED row with no claim id passing, or a `plan.md` whitespace edit changing the Last refined date.

### REQ-M22 (Ubiquitous): Dependency and secret gates exist where the docs claim them
THE SYSTEM SHALL:
- run `npm audit --omit=dev --audit-level=critical` for the root and for `stratum/` in `ci.yml`, failing on a critical production advisory;
- run `actions/dependency-review-action` on PRs;
- provide a committed pre-commit hook (`core.hooksPath=.githooks`, installed by `scripts/setup`) that runs `gitleaks protect --staged` and fails on findings.

SBOM and provenance are deferred until a release artifact exists; `release-sign.yml` signs only `SKILL.md` files.
**Enforced by:** CI job and git hook.
**Falsified by:** a PR adding a dependency with a known critical advisory that passes, or a staged fake AWS key that commits.

### REQ-M23 (Unwanted behaviour): An emptied or assertion-free suite never reads as PASS
IF `npm test` at the root, or in `stratum/`, runs fewer tests than the floor committed in `governance/test-floors.json`, THEN CI SHALL fail. Floors may only rise. `scripts/check-assertions.mjs` SHALL also fail on a new test file with zero `assert`/`expect` calls.
**Enforced by:** CI floor check plus lint.
**Falsified by:** deleting a test file and CI staying green.

### REQ-M24 (Ubiquitous): The dashboard observes; it never presents stale or unobserved state as live
THE SYSTEM SHALL make `scripts/graph-dashboard/server.mjs`:
- join each run to `graph-cycles/*/run.json` by `runId`;
- display the run.json `status` and `cycleId` (replacing the hard-coded `null` at `:454`);
- label a run with no run record `observed: false, state: NOT_OBSERVED`;
- mark a node `stale` when its last journal event is more than 18 minutes old and run.json is not `running` (PB-57; `:438`), or more than 3 hours old when run.json still says `running`. An orchestrator that dies leaves its record at `running`, and live agents have been measured silent for up to 74 minutes (amended 2026-09-25 after review `wf_6e861584-e0b`);
- join the earlier run named in a record's `resumedFrom` to that cycle as `superseded`, never as `running`;
- label non-sprint Workflow runs as such.

It SHALL remain read-only and loopback-only.
**Enforced by:** code plus `tests/graph-dashboard/state-readers.test.mjs` with a killed-run fixture.
**Falsified by:** the 2026-09-15 run `wf_d07743ef-c04` still shown `active: true`.

### REQ-M25 (Unwanted behaviour): History never becomes a detector skip list
IF the reviewer, security or validator prompt templates in `sprint-cycle.js` contain `already fixed`, `do not re-report` or `known issue`, or any `.gitleaksignore` line is not a full `commit:file:rule:line` fingerprint, THEN `scripts/lint-detector-prompts.mjs` in `ci.yml` SHALL fail.
**Enforced by:** CI lint.
**Falsified by:** adding "known issue: X" to the security prompt and CI staying green.

### REQ-M26 (Ubiquitous): Cross-tool claims are backed by adapters
THE SYSTEM SHALL either provide `.cursor/rules/devops.mdc` (`alwaysApply: true`, citing `AGENTS.md` and `constitution/PRINCIPLES.md`) plus `scripts/lint-adapters.mjs` in CI, or remove "Universal across Claude Code, Codex, Cursor, Antigravity, Kiro" from `.claude-plugin/plugin.json:5`. The owner decides which.
**Enforced by:** CI lint, or removal of the claim.
**Falsified by:** `plugin.json` claiming Cursor support while `.cursor/` does not exist.

### REQ-M27 (Ubiquitous): Pentest and DAST are executable, target-bound, and fail loudly
THE SYSTEM SHALL provide `.github/workflows/dast.yml` (weekly plus dispatch; never a required PR context). It:
- starts the Stratum Fastify proxy in-runner on loopback as the only allowed target, checked by `scripts/validate-dast-target.mjs` against a loopback allowlist;
- runs pinned nuclei and a ZAP baseline;
- fails on a high or critical finding, on a missing report, or on an unhealthy target, reporting the run as INDETERMINATE (red).

Until the pentest MCPs exist and are registered, the claims "denied at the hook layer" (`docs/SECURITY.md:33-35`) and "least-privilege gate" (`role-mapping.md:62`) SHALL be deleted, not implemented with an environment variable that nothing sets per role.
**Enforced by:** CI workflow plus target validator; tests for the validator.
**Falsified by:** `dast.yml` concluding success with no nuclei report artifact.

### REQ-M28 (Event-driven): The graph installs into BrightPath only through BrightPath's own gates
WHEN the DevOPs graph is proposed for BrightPath, THE SYSTEM SHALL provide `scripts/install-brightpath.sh --dry-run --mode vendored|plugin`. The script:
- clones BrightPath HEAD into a scratch worktree, never the live checkout;
- applies the chosen install (vendored adapters citing `MASTERPIECE_WORKFLOW.md`, `PLATFORM_INVARIANTS_SPEC.md` and `docs/audit/VERIFICATION.md`, with clause stubs; or plugin-only), adding `.workflow/` to BrightPath's `.gitignore`;
- runs BrightPath's own `node scripts/check-masterpiece-lifecycle.mjs` and `node scripts/check-spec-traceability.mjs` there;
- exits non-zero if either fails.

Any bridge SHALL call BrightPath's `engineering_graph.py next|status --evidence-dir <retained dir>` in-tree. It SHALL never pass `--root` from DevOps, and SHALL never replace BrightPath's graph as its primary scheduler (BP `ENGINEERING_GRAPH.md:3-15`). The install SHALL NOT start until REQ-M1, M3, M4, M15, M16, M17 and M18 are `verified`, because installing earlier would ship a self-certifying pipeline.
**Enforced by:** the dry-run script's exit code, which runs BrightPath's gate [41] checkers.
**Falsified by:** a real BrightPath checkout modified by the script, or a dry-run reporting pass while BrightPath's checker exits non-zero.

### REQ-M29 (Ubiquitous): Documentation matches the mechanism
THE SYSTEM SHALL correct, at the latest in the cycle that implements the matching REQ, every document that claims enforcement which does not exist:
- `docs/LAUNCH_READINESS.md:49` (Semgrep and DeepTeam "green") and `:241` ("production-complete");
- `docs/SECURITY.md:12-14` and `:33-35`;
- `.github/workflows/security-scan.yml:127-131` ("blocks the branch-protection gate");
- `governance/graph/role-mapping.md:62`;
- `governance/graph/graph-halt.md:9-11` (halt checked "before any other check");
- `scripts/graph-dashboard/README.md:151-161` ("not recoverable").

**Enforced by:** REQ-M20's checker for SECURITY.md; REQ-M10's lint for LAUNCH_READINESS; PROCESS for the rest.
**Falsified by:** any listed sentence still present once its REQ is verified.

---

## Acceptance criteria

### AC-M1.1 (REQ-M1)
**Given** fake `agent()` results with tester `PASS`, security `PASS`, validator `PASS` and reviewer `approved: false` **When** `sprint-cycle.js` runs under the `workflow-faults.test.mjs` harness **Then** `readyForPR` is false. The same holds for security `FAIL` with everything else PASS, and for any tester `FAIL`.

### AC-M1.2 (REQ-M1)
**Given** all stages PASS and reviewer `approved: true` with an empty BLOCKER list **When** the workflow runs **Then** `readyForPR` is true (a positive control, so the gate is not vacuous).

### AC-M2.1 (REQ-M2)
**Given** a journal fixture whose tester proof is `{command: "exit 1", exit_code: 0}` **When** `node scripts/graph-rerun-proofs.mjs --journal <fixture>` runs **Then** it exits non-zero and names the task. **Given** the security scan reports `scanned_files: 0` **Then** it also exits non-zero. **Given** matching exit codes and scanned counts at or above the floor **Then** it exits 0.

### AC-M3.1 (REQ-M3)
**Given** a tester result `{passed: true, outcome: 'INDETERMINATE'}` **When** the workflow runs **Then** `readyForPR` is false and the cycle outcome contains `INDETERMINATE`. **Given** `graph-run-record.mjs update --status indeterminate` **Then** it is accepted.

### AC-M4.1 (REQ-M4)
**Given** the reviewer agent returns `null` **When** the workflow runs **Then** the thrown `BLOCKED_BY_ENVIRONMENT:` JSON has `"class":"needs_human"`. **Given** an agent returns `blocked_by_environment: {class: 'code'}` **Then** the result is rejected by the schema or mapped to `needs_human`.

### AC-M5.1 (REQ-M5)
**Given** `preflight.json` `{status: 'ready', git_sha: <not HEAD>}` **When** `graph-run-record.mjs launch` runs **Then** it throws and writes no `run.json`. The same holds when `ran_at` is 16 minutes old. **Given** a `blocked.md` newer than `preflight.json` **When** `update --clearBlocked true` runs **Then** it throws.

### AC-M6.1 (REQ-M6)
**Given** a journal whose final result has `readyForPR: false` **When** `update --status completed` runs **Then** it throws. **Given** a result with `readyForPR: true` and a passing rerun **Then** status becomes `completed` and exactly one dashboard row for that `cycleId` is appended. A second call does not add another row.

### AC-M7.1 (REQ-M7)
**Given** a planner result with `ambiguities: ['X']` and no acknowledgement **When** the workflow runs **Then** it throws `AMBIGUITY_BLOCK:` before any `coder:` label is invoked. **Given** `args.acknowledgedAmbiguities: ['X']` **Then** Build runs. The same holds for a non-empty `conflicts[]`.

### AC-M8.1 (REQ-M8)
**Given** a spec whose Status is `draft` **When** `launch --spec-ref specs/x.md#REQ-X1` runs **Then** it throws. **Given** Status `approved` and a REQ with no AC **Then** it throws. **Given** approved, fully AC-covered and with Falsified-by lines **Then** it succeeds. **Given** a planner task with an empty `ac_ids` **Then** the schema rejects it.

### AC-M8.2 (REQ-M8)
**Given** a spec with `**Status**: AUTHORED 2026-09-10` **When** `node scripts/lint-spec-status.mjs` runs **Then** it exits non-zero naming the file.

### AC-M9.1 (REQ-M9)
**Given** a claim with `description` 300 characters long **When** the validator runs **Then** it exits non-zero naming `maxLength`. **Given** `--claim nope` **Then** it exits non-zero. **Given** `--all` with zero claims **Then** it exits non-zero.

### AC-M9.2 (REQ-M9)
**Given** a type `implementation` claim without `proof.red` **Then** the validator rejects it. **Given** `proof.red.sha` at which the test command exits 0 **When** run without `--no-rerun` **Then** the validator rejects it (the RED is not RED).

### AC-M10.1 (REQ-M10)
**Given** a claim `state: production_complete` without a deploy proof **Then** the validator rejects it. **Given** `state: code_converged` while `graph-converge.mjs status` exits non-zero **Then** it is rejected. **Given** the current `docs/LAUNCH_READINESS.md:241` **When** `lint-readiness-claims.mjs` runs **Then** it fails until the text is corrected or cites a supporting claim. **Given** the phrase "live dashboard" **Then** the lint does not fail.

### AC-M11.1 (REQ-M11)
**Given** a frozen anchor **When** `record` is called with two distinct zero-finding run ids on unchanged HEAD and inputs **Then** `status` exits 0 and a third `record` is refused. **Given** any of these instead:
- a changed HEAD;
- a changed `inputs_sha256`;
- a reused run id (including the anchor's);
- a run started before the anchor;
- a journal with one finding

**Then** `repeats` resets to 0 and `status` exits non-zero. `record` has no `--findings` flag.

### AC-M12.1 (REQ-M12)
**Given** `work-graph.json` fixtures with a cycle, a dangling edge, a node containing `"done": true`, and a `blueprint.md` heading with no node **When** `graph-next.mjs` runs on each **Then** each exits non-zero with a distinct reason. **Given** a valid graph **Then** it prints the frontier, and `launch` refuses an item not on it.

### AC-M13.1 (REQ-M13)
**Given** a stubbed `gh` returning 404 for `required_status_checks` **When** preflight runs **Then** `branch.protection` is `fail` and status is `needs_human`. **Given** a stub listing every context in `required-checks.yml` with 1 required approval **Then** the check passes.

### AC-M14.1 (REQ-M14)
**Given** a Semgrep JSON fixture with a non-empty `errors[]`, or `paths.scanned` below the floor **When** `node scripts/assert-scan.mjs` runs **Then** it exits non-zero. **Given** `run-redteam.sh` with no key and `GITHUB_EVENT_NAME=push` on `main` **Then** it exits non-zero.

### AC-M15.1 (REQ-M15)
**Given** a test key listed in a fixture `allowed_signers` and a marker signed over `{cycle, sha: HEAD, action: 'deploy'}` **When** a deploy-shaped command runs **Then** the gate allows it. **Given** a `{}` marker, an unsigned marker, a signature over another `sha`, or a key not listed **Then** the gate exits 2. **Given** two billing markers signed by the same key **Then** it exits 2.

### AC-M16.1 (REQ-M16)
**Given** the probe matrix, each case with `graph-halt` present or absent as it specifies (`git -C . commit`, `gh pr merge`, `gh release create`, `supabase db push`, `git push origin v1.0.0`, `git push origin :v0.2.0`, `git push origin :refs/tags/v0.2.0`, `git push origin +HEAD:stratum-merge`, `git -C . tag -d v0.2.0`, `git update-ref refs/tags/v0.2.0 HEAD`, and a push with no upstream touching a billing path) **When** `npm test` runs `tests/hooks/*` **Then** each case exits 2, and `echo git tag -d v0.2.0` exits 0. **Given** zero or two `running` run records **Then** a deploy-shaped command exits 2.

### AC-M17.1 (REQ-M17)
**Given** a scratch repository and a one-task Workflow whose agent runs `git commit --allow-empty -m probe` while a `running` run record exists **When** it runs **Then** the recorded claim states whether the hook fired (exit 2) or not. If not, the coder and tester `agent()` calls in `sprint-cycle.js` carry `isolation: 'worktree'`, which a test asserts.

### AC-M17.2 (REQ-M17)
**Given** a `running` run record **When** the hook receives `git commit -m x`, `gh pr create` or an MCP `merge_pull_request` tool call **Then** it exits 2. **Given** no running record **Then** a plain commit exits 0. **Given** a `running` record **When** `launch` runs for another cycle **Then** it throws.

### AC-M18.1 (REQ-M18)
**Given** the `Write|Edit` hook **When** it receives an Edit to `hooks/universal/pre-tool/deploy-gate.sh`, `.claude/settings.json` or `.workflow/state/graph-halt` **Then** it exits 2. **Given** Bash `rm .workflow/state/graph-halt` or `echo > .claude/settings.json` **Then** `deploy-gate.sh` exits 2. **Given** an Edit to `README.md` **Then** it exits 0.

### AC-M19.1 (REQ-M19)
**Given** an `events.jsonl` fixture with a deleted middle line **When** preflight runs **Then** the chain check fails and status is `needs_human`, and the dashboard snapshot shows `TAMPERED`.

### AC-M20.1 (REQ-M20)
**Given** a REQ whose `Enforced by:` names an unwired hook **When** `check-enforcement.mjs` runs **Then** it exits non-zero. **Given** a baseline listing REQ-X as enforced and the spec now saying `UNENFORCED` **Then** it exits non-zero.

### AC-M21.1 (REQ-M21)
**Given** a `CLOSED` item without a claim id **When** `lint-closures.mjs` runs **Then** it exits non-zero. **Given** a whitespace-only `plan.md` edit **Then** the Last refined date in `LAUNCH_READINESS.md` is unchanged.

### AC-M22.1 (REQ-M22)
**Given** a staged file containing a synthetic AWS access-key-shaped string **When** `git commit` runs with the repo hooks path **Then** the commit fails. **Given** `ci.yml` **Then** it contains the audit and dependency-review steps, and each fails on its fixture.

### AC-M23.1 (REQ-M23)
**Given** a test file removed so the count drops below the floor **When** the floor check runs **Then** it exits non-zero. **Given** a new test file with no assertions **Then** `check-assertions.mjs` exits non-zero.

### AC-M24.1 (REQ-M24)
**Given** a fixture of a run whose last event is 30 minutes old and whose run.json is `failed` **When** the snapshot is built **Then** the run is not active and its node is `stale`. **Given** a run with no run.json **Then** it shows `NOT_OBSERVED`. **Given** a run with run.json **Then** `cycleId` is not null.

### AC-M25.1 (REQ-M25)
**Given** "known issue" inserted into a copy of the security prompt **When** the lint runs **Then** it exits non-zero. **Given** a `.gitleaksignore` line `*.test.ts` **Then** it exits non-zero.

### AC-M26.1 (REQ-M26)
**Given** `plugin.json` naming Cursor **When** `lint-adapters.mjs` runs **Then** it exits 0 only if `.cursor/rules/devops.mdc` exists with `alwaysApply: true` and cites `AGENTS.md`.

### AC-M27.1 (REQ-M27)
**Given** `DAST_TARGET=https://example.com` **When** `validate-dast-target.mjs` runs **Then** it exits non-zero. **Given** the proxy not started **Then** `dast.yml` fails. **Given** a nuclei run that produced no report **Then** it fails.

### AC-M28.1 (REQ-M28)
**Given** a BrightPath clone **When** `install-brightpath.sh --dry-run --mode vendored` runs **Then** the live `/Users/milto/Projects/BrightPath` `git status` is byte-identical before and after, and the script's exit status equals the OR of BrightPath's two checkers' exit statuses in the scratch worktree.

### AC-M29.1 (REQ-M29)
**Given** each REQ at state `verified` **When** its listed document lines are grepped **Then** the false sentence is gone or rewritten to name the actual mechanism.

---

## Traceability

| REQ | BrightPath tenet it adopts | DevOPs gap it closes (map evidence) |
|---|---|---|
| M1, M2 | Nothing certifies itself (`engineering_graph.py:121`; RED/GREEN `graph_git_publication.py:676-683`) | `readyForPR` ignores reviewer and security (`sprint-cycle.js:317`, `:298`); scanner runs are self-reported |
| M3, M4, M5, M6 | INDETERMINATE (`loop.py:2383-2501`; INV-VERIFY-015) | null→`api` (`:47`); free-string class (`:26`); stale preflight clears a block (`graph-run-record.mjs:51-54`); caller-asserted status |
| M7 | Material ambiguity is INDETERMINATE (`loop.py:781-784`); authority order (`MASTERPIECE_WORKFLOW.md:35-61`) | ambiguities logged and ignored (`:139`) |
| M8 | Traceability chain (`MASTERPIECE_WORKFLOW.md:183-202`); spec integrity first (`:11-33`) | free-string backlog item; unapproved specs; link 1 unenforced even in BrightPath |
| M9 | Mutation proof RED/GREEN (`check-pr-spec-contract.mjs:38-48`) | schema never read; PB-60 vacuous CI |
| M10 | Completion states (`lifecycle-contract.json:230-237`) | `LAUNCH_READINESS.md:241` production-complete |
| M11 | Frozen convergence (`control_plane.py:25761-25951`) | no convergence definition |
| M12 | Graph primacy (`ENGINEERING_GRAPH.md:3-37`); Blueprint reconciliation (`blueprint_reconciliation.py:43-56`) | linear pipeline, no DAG |
| M13 | Required contexts (`branch-protection-check.yml:88-153`) | 0 required checks on `main` |
| M14 | Scanned-count floors (`security.yml:39-160`; `nuclei-scan.yml:108-125`) | Semgrep false pass; DeepTeam SKIPPED as success |
| M15, M18, M19 | Authenticated owner decisions (`graph_git_publication.py:752-776`) | free-text approvers; agent-writable markers and hooks; forgeable `events.jsonl` |
| M16, M17 | Protected branches plus mechanical git gates | hook bypass matrix; prompt-only commit ban; ungated MCP writes |
| M20, M21, M29 | No gate without a clause (`check-spec-traceability.mjs:1-35`) | unwired hooks cited as enforcement; self-asserted closures |
| M22, M23 | Dependency audits; `require_files`/`node_test_floor` (`ci-local-gates.sh:1-50`) | no SCA; no pre-commit; no suite floors |
| M24 | Observer dashboard (`ENGINEERING_GRAPH.md:460-530`) | PB-57 |
| M25, M26 | No skip list; tool parity (`check-masterpiece-lifecycle.mjs:86-110, 387-419`) | unguarded compliance; no Cursor adapter |
| M27 | DAST and pentest (`nuclei-scan.yml`, `zap-scan.yml`, `pentest/SKILL.md`) | pentest on paper only |
| M28 | Tool parity and graph primacy on BrightPath | no install path |
