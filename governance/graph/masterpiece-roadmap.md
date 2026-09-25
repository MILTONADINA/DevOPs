# Masterpiece roadmap: graph backlog for specs/graph/M-masterpiece-standard.md

**Status**: draft. It depends on the owner approving `specs/graph/M-masterpiece-standard.md`.
**Last updated**: 2026-09-25
**Source**: the read-only maps of BrightPath (HEAD `6480978a0`) and DevOPs (branch `feature`), 22 gaps, and two adversarial checker passes.

## How to read this

- Each item is one graph backlog item. Until REQ-M12 lands, it is fed to `/sprint` as `backlogItem` plus `specRef`.
- **Size:** XS is under 1 hour of hand edits. S is one cycle with 1-3 tasks. M is one cycle with 4-8 tasks. L is two or more cycles.
- **Proof:** the command, and the exit status that must be observed. Per REQ-M9 the proof must first fail on the unfixed tree (RED) and then pass (GREEN).
- **Order:** by what unblocks what. Priorities 1-12 make the pipeline unable to certify itself. Everything after that builds on them.
- Nothing here is `verified` until its proof is recorded as a validated claim. A cycle that lands is `implemented` until then.

### Outcome of the checker passes

- **Dropped as proposed, replaced by lighter mechanisms:**
  - G14, the per-requirement Blueprint ledger, became section-level dispositions on work-graph nodes (MR-14).
  - G15, a validator-reported spec-integrity verdict, became owner approval plus the REQ/AC/Falsified-by lint (MR-11).
  - G19, an authority-order file, became one `AGENTS.md` line plus `conflicts[]` feeding the ambiguity block (MR-02).
- **Corrections applied:**
  - The BrightPath citations are fixed: G05 now cites `graph_git_publication.py:752-776`; G07's guarantee is protected branches and required contexts, not `guard-dangerous-bash`; G20 had a filename typo.
  - `gh`-comment "authentication" was replaced by `ssh-keygen -Y` signatures.
  - DAST gating by a `DEVOPS_GRAPH_ROLE` variable was replaced by deleting the claim.
  - The cycle-7 dashboard row now exists (reconstructed by hand), which supports G17 rather than weakening it.

## Backlog

| # | Item | Size | REQ | Proof (RED on today's tree, then GREEN) | Depends on |
|---|---|---|---|---|---|
| 0 | **Doc corrections now (hand edit, no cycle).** *(Done 2026-09-25 in the MR-0 PR; `governance/graph/graph-halt.md` is `slash-commands/universal/graph-halt.md`.)* Remove false claims: `docs/LAUNCH_READINESS.md:49` (Semgrep and DeepTeam "green") and `:241` ("production-complete"); `docs/SECURITY.md:12-14` and `:33-35`; `.github/workflows/security-scan.yml:127-131`; `governance/graph/role-mapping.md:62`; `governance/graph/graph-halt.md:9-11`; `scripts/graph-dashboard/README.md:151-161`. | XS | M29 | `grep -nE 'hook layer\|Semgrep, DeepTeam.*green\|production-complete' docs/SECURITY.md docs/LAUNCH_READINESS.md` returns nothing (exit 1) | none |
| 1 | **Subagent-hook proof.** *(Done 2026-09-25: project PreToolUse Bash hooks DO fire inside Workflow subagents; a matched echo was blocked in both the main session and a subagent, an unmatched one ran in both; `wf_4cb7f7ae-d8e`, `wf_da7ae548-694`.)* A one-task Workflow in a scratch repo whose agent runs `git commit --allow-empty` against a hook that blocks it. Record whether PreToolUse fires in Workflow subagents. This decides whether MR-06 can rely on hooks or needs `isolation: 'worktree'`. | S | M17 (AC-M17.1) | a recorded claim with the observed exit code (2 means hooks fire, 0 means they do not) | owner permission (Q8) |
| 2 | **First cycle: code gates in `sprint-cycle.js` and the run record.** `readyForPR` becomes the AND of all verdicts. Tri-state `outcome` plus `indeterminate` status. Null result becomes `needs_human`, and class becomes an enum. Fresh-preflight binding for `launch` and `clearBlocked`. `AMBIGUITY_BLOCK` over `ambiguities[]` and `conflicts[]`. One precedence line in `AGENTS.md`. | M | M1, M3, M4, M5, M7 | `node --test tests/graph-resilience/` with new cases AC-M1.1/1.2, AC-M3.1, AC-M4.1, AC-M5.1, AC-M7.1 fails before and passes after; `npm test` exits 0 | none (runs against a draft spec; see the note on first-cycle scope) |
| 3 | **Hook regression tests plus gate hardening.** Commit the probe matrix as failing tests first. Then: halt check before the pre-filter; widened patterns; cycle id taken from the running run.json; no-upstream fail-closed; no false positive on `echo`. | M | M16 | `node --test tests/hooks/` (AC-M16.1): 11 bypass cases exit 2 and the `echo` case exits 0 | 2 (run.json `running` semantics) |
| 4 | **Protect gate configuration.** A PreToolUse `Write\|Edit` hook denying `hooks/`, `.claude/settings.json`, `.claude/workflows/`, approval markers, `graph-halt`, `blocked.md` and `allowed_signers`. Bash `rm`/`mv`/redirects onto them are denied in `deploy-gate.sh`. | S | M18 | `node --test tests/hooks/protected-paths.test.mjs` (AC-M18.1) | 3; the owner applies the `settings.json` change by hand (the new hook forbids agent edits to it) |
| 5 | **Signed approvals.** `ssh-keygen -Y sign/verify` markers, `governance/graph/allowed_signers`, payload `{cycle, sha==HEAD, action, approver, ts}`, two distinct keys for billing. Update `/sprint-approve`, `/graph-resume` and the blocked-clear runbooks. | M | M15 | `node --test tests/hooks/deploy-gate.test.mjs` (AC-M15.1) with a throwaway test key: `{}`, unsigned, wrong-sha, unlisted-key and same-key-twice all exit 2 | 3, 4; owner key choice (Q4) |
| 6 | **Cycle commit lock, MCP write gating, single-flight.** Block `git add/commit/push/tag` and `gh pr create/merge` while a run is `running`. Add a PreToolUse matcher for the GitHub MCP write tools. `launch` refuses a second running cycle. If MR-1 showed hooks do not fire in subagents, add `isolation: 'worktree'`. | M | M17 | `node --test tests/hooks/cycle-commit-lock.test.mjs` (AC-M17.2) | 1, 2, 3 |
| 7 | **Honest scans.** *(Semgrep part done 2026-09-25 in PR #178: pinned `semgrep scan` that fails on findings, fatal errors and an empty scan. Still open: `assert-scan.mjs`, `scan-floors.yml`, `run-redteam.sh`.)* Replace `semgrep-action@713efdd` with `semgrep scan --json --error` plus `scripts/assert-scan.mjs` and `governance/scan-floors.yml`. `run-redteam.sh` exits non-zero when it was meant to run. | S | M14 | `node --test tests/ci/assert-scan.test.mjs` with crashed and zero-scanned fixtures (AC-M14.1); then the first `main` run shows a non-zero `paths.scanned` in its log | none |
| 8 | **Merge gate.** *(Owner-side part applied 2026-09-25: required checks validate, stratum-test, setup-linux, gitleaks, semgrep, strict, enforce_admins on, 0 approvals, per Decision 2. Still open: `governance/required-checks.yml` and the preflight `branch.protection` check.)* Owner applies required contexts and 1 approval on `main`. Add `governance/required-checks.yml` and preflight check `branch.protection`. | S | M13 | `node --test tests/graph-resilience/preflight.test.mjs` with a stubbed `gh` (AC-M13.1); live: `gh api repos/:owner/:repo/branches/main/protection/required_status_checks` returns 200 | owner action (Q1); 7 before semgrep is listed |
| 9 | **Orchestrator rerun and journal-derived status.** `scripts/graph-rerun-proofs.mjs`: tester `proof` and security `scans[]` become required schema fields. `graph-run-record.mjs update` derives status from the journal and appends the dashboard row. | M | M2, M6 | `node --test tests/graph-resilience/rerun-proofs.test.mjs tests/graph-resilience/run-record.test.mjs` (AC-M2.1, AC-M6.1) | 2 |
| 10 | **Claims that mean something.** The validator loads `claim-schema.yml`; it is non-zero on an empty set or a missing id; `proof.red`; a committed proof set or index (PB-60); the `/sprint` post-cycle `--claim` check. | M | M9 | `npx tsx --test tests/verification/claim-validator.test.ts` (AC-M9.1, AC-M9.2); CI validate job fails on an empty set | owner PB-60 decision (Q3) |
| 11 | **Approved-spec binding.** `launch --spec-ref` requires `Status: approved`, an existing anchor, REQ→AC coverage and Falsified-by lines. Planner `ac_ids`. Claim `outcome_ref` and `decision_ref`; `signal`/`recovery` only for deploy and migration. `lint-spec-status.mjs`. | M | M8 | `node --test tests/graph-resilience/run-record.test.mjs` (AC-M8.1); `node scripts/lint-spec-status.mjs` exits non-zero on today's `AUTHORED` headers (AC-M8.2) | 10; owner approves specs (Q2) |
| 12 | **Completion-state vocabulary.** The `state` enum in the claim schema; validator refusals; `lint-readiness-claims.mjs` limited to state tokens and version-table status cells. | S | M10 | AC-M10.1: the lint fails on the uncorrected `LAUNCH_READINESS.md:241` fixture and passes on "live dashboard" | 10 |
| 13 | **Frozen convergence.** `scripts/graph-converge.mjs freeze\|record\|status`, with findings derived from the journal and no `--findings` flag. | M | M11 | `node --test tests/graph/converge.test.mjs` covering each reset branch and third-repeat refusal (AC-M11.1) | 9, 12 |
| 14 | **Work graph, first slice (about 100 lines).** `governance/graph/work-graph.json` (requires-only edges, no status or done); `blueprint.md` section-heading nodes with dispositions; the `graph-next.mjs` validator and frontier; `launch` refuses items off the frontier. **Second slice:** node state from claims at the current fingerprint. | L | M12 | `node --test tests/graph/work-graph.test.mjs` (AC-M12.1) | slice 1 after 11; slice 2 after 10 |
| 15 | **Observer dashboard.** *(Done 2026-09-25 in the MR-15 PR: run.json join, `NOT_OBSERVED`, 18-minute `stale`, real `cycleId`, non-sprint runs labelled; the 2026-09-15 run `wf_d07743ef-c04` now shows inactive with a stale tester node.)* Join run.json, `NOT_OBSERVED`, a stale threshold of 18 minutes, a real `cycleId`, and non-sprint runs labelled (closes PB-57). | S | M24 | `node --test tests/graph-dashboard/state-readers.test.mjs` with a killed-run fixture (AC-M24.1) | 9 |
| 16 | **Tamper-evident events.** A `prev_sha256` chain; a preflight check; a dashboard `TAMPERED` badge. | S | M19 | `node --test tests/graph-resilience/events-chain.test.mjs` (AC-M19.1) | 4, 15 |
| 17 | **Enforced-by traceability.** `scripts/check-enforcement.mjs` (forward direction only), `governance/enforcement-baseline.json` as a ratchet, scoped to `specs/graph`, `specs/security` and the `docs/SECURITY.md` tier table. | M | M20 | `node --test tests/ci/check-enforcement.test.mjs` (AC-M20.1); running it on today's `docs/SECURITY.md:12` fails | 0 |
| 18 | **Evidence-backed closures and freshness.** `lint-closures.mjs`; `sync-lr-refined-date.sh` bumps only under `/launch-readiness`. | S | M21 | AC-M21.1 tests | 10 |
| 19 | **Supply chain and local secrets.** `npm audit` (critical, production) for root and `stratum/`; dependency-review on PRs; `.githooks/pre-commit` with `gitleaks protect --staged`. | S | M22 | AC-M22.1: a staged synthetic key fails the commit in a scratch clone; CI step fixtures | none |
| 20 | **Test floors.** *(Done 2026-09-25: `governance/test-floors.json` (root 339, stratum 1092), `scripts/check-test-floor.mjs` in both CI jobs with a PR ratchet, `scripts/check-assertions.mjs` on added test files.)* `governance/test-floors.json` (only rises) and `check-assertions.mjs`. | S | M23 | AC-M23.1 in a scratch worktree with one test deleted | none |
| 21 | **DAST.** `.github/workflows/dast.yml` against the in-runner Stratum proxy on loopback; `validate-dast-target.mjs`; fails on a missing report or an unhealthy target. | M | M27 | `node --test tests/ci/validate-dast-target.test.mjs` (AC-M27.1); a dispatch run uploads a nuclei report artifact | 7 |
| 22 | **No skip list.** `lint-detector-prompts.mjs` bans prompt phrases and requires full fingerprints in `.gitleaksignore`. | S | M25 | AC-M25.1 | none (lowest value; DevOPs already complies) |
| 23 | **Tool parity.** *(Done 2026-09-25 by removal, per Decision 6: the plugin.json and package.json descriptions no longer claim Cursor, Antigravity or Kiro support.)* Either add the Cursor adapter plus `lint-adapters.mjs`, or remove the claim at `plugin.json:5`. | S | M26 | AC-M26.1 | owner decision (Q6) |
| 24 | **BrightPath install dry-run.** `scripts/install-brightpath.sh --dry-run --mode vendored\|plugin` runs BrightPath's own gate [41] checkers in a scratch clone. The bridge to BrightPath's `engineering_graph.py next` is deferred until a dry-run passes. | L | M28 | AC-M28.1: the live BrightPath `git status` is unchanged, and the exit code equals BrightPath's checkers' result | 2, 3, 4, 5, 6 verified; owner decision (Q5) |

### Deferred (recorded, not dropped)

| Item | Why deferred | Unblocks when |
|---|---|---|
| Verifier calibration: planted-defect canaries for the reviewer and security agents, with a confirmation floor (BP `loop.py`, 70%) | Needs funded API spend | Owner funds judged runs (Q9) |
| Two-axis reachability fields in reviewer and security findings (BP INV-VERIFY-058) | No dormant production code paths exist yet | A deployment topology exists |
| Release, production readiness and aftercare: staging rehearsal, restore proof, SLOs, post-deploy verify, SBOM/provenance | No production deployment topology (`plan.md` §4; ADR-0020) | Topology decided; REQ-M10 already makes `production_complete` unreachable until then |
| Evidence-dir device/inode binding (BP `ENGINEERING_GRAPH.md:124-139`) | Minor | After MR-16 |
| Reverse enforced-by direction (every hook and job cited by a REQ) | BrightPath's full weight | After MR-17 has been stable for one release |

### Note on first-cycle scope

MR-2 runs before REQ-M8 (approved-spec binding) exists, so it launches against this draft spec. The pipeline cannot yet refuse that. The owner's approval of the spec (Q2) should come before MR-11 at the latest. MR-2 changes the pipeline that runs it, so the validator for MR-2 must re-run `node --test tests/graph-resilience/` itself, and the owner reviews the diff before any commit (Phase 0).

## Decisions recorded 2026-09-25

The owner delegated these to the orchestrator's recommendation ("i will go with your recommendations since you have the advisor"). Each one can be overridden.

1. **Spec status.** `specs/graph/M-masterpiece-standard.md` stays `draft` until the owner approves it. MR-2 and the other early cycles run against the draft, as MR-2 already states.
2. **Merge gate (MR-8).** Required status checks on `main`: `validate`, `stratum-test`, `setup-linux`, `gitleaks` and `semgrep`, with `enforce_admins` on so that an admin token cannot merge a red PR. No required approving review count: agents act with the owner's token, so a review requirement would be satisfied by the same identity it is meant to check. The human gates are signed approvals (MR-5) and the existing deploy and billing markers.
3. **PB-60 (MR-10).** Commit the claim YAML files, their proof scripts and `_checks/` (never the logs) after a gitleaks pass, so CI can validate schema and SHA reachability for real.
4. **Signing keys and the second billing approver (MR-5).** Owner only; not decided here. Until they exist, the four-eyes rule stays as it is.
5. **BrightPath install (MR-24).** Evaluate both the vendored and the plugin-only mode in the dry-run and choose on evidence.
6. **Tool parity (MR-23).** Remove the unbacked "Cursor, Antigravity, Kiro" universality claim until an adapter and its parity lint exist.
7. **Omissions.** Accepted as listed in the spec.
8. **MR-1.** Run the one-time subagent-hook proof in a scratch repository outside both projects.
9. **DeepTeam and Claude Security Review.** Keep both. They skip visibly while unfunded and are never cited as passing. Funding is the owner's decision.
10. **MR-0.** Approved as a hand edit.
11. **Protected paths (MR-4).** Wait for signed approvals (MR-5), then allow edits to protected paths only with a signed marker.
