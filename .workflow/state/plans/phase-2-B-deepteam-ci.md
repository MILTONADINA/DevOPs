# Phase 2 / Area B — OWASP ASI 2026 Red-Team in CI (DeepTeam) — Implementation Plan

**Plan ID**: phase-2-B-plan
**Spec**: specs/phase-2/B-deepteam-ci.md
**Threat model**: docs/threat-models/phase-2/B-deepteam-ci.md
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- Step 1 reviewer feedback already folded into spec B: REQ-B1 PR trigger scoped to agent-behavior paths; REQ-B5 production default `red_team.per_run_usd: 0.50` + override path. Plan honours both.
- Threat model B / ASI07 row (Resource Exhaustion) is mitigated by NFR-B1 wall-clock cap + REQ-B5 budget brake — confirmed end-to-end in tasks B.07 + B.11.
- AST08 (Action update tampering) covered by REQ-B8 SHA-pinning — task B.10.

## Task list

### Task B.01 — Extend `cost-controls/budget.yml` with `red_team` section
**REQ**: REQ-B5
**AC**: AC-B5.2
**Type**: implementation
**Effort**: ~20 min
**Depends on**: (none)
**Success criterion**: `cost-controls/budget.yml` parses with `red_team.per_run_usd: 0.50` present at the top level of the `red_team` block. AC-B5.2 passes.

### Task B.02 — Author `scripts/run-redteam.sh` POSIX wrapper
**REQ**: REQ-B7
**AC**: AC-B7.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: B.01
**Success criterion**: The wrapper reads `cost-controls/budget.yml` `red_team.per_run_usd`, invokes DeepTeam with the `OWASP_ASI_2026()` framework, and exits with the same status that the CI run would produce. AC-B7.1 passes on a clean clone with DeepTeam installed.

### Task B.03 — Modify `.github/workflows/security-scan.yml`: add `deepteam` job with `paths:` filter (REQ-B1)
**REQ**: REQ-B1
**AC**: AC-B1.1, AC-B1.2
**Type**: implementation
**Effort**: ~45 min
**Depends on**: B.01, B.02
**Success criterion**: The new `deepteam` job triggers on PRs whose changed files match `skills/**`, `hooks/**`, `subagents/**`, `constitution/**`, `mcp-configs/**`, `analyzer/**`, or `governance/owasp-asi-2026/**`. Documentation-only PRs (changes confined to `docs/**`, `README.md`, etc.) skip the job. AC-B1.1 + AC-B1.2 both pass.

### Task B.04 — Add push-to-`main` trigger (defense-in-depth backstop, REQ-B2)
**REQ**: REQ-B2
**AC**: AC-B2.1
**Type**: implementation
**Effort**: ~20 min
**Depends on**: B.03
**Success criterion**: Direct pushes to `main` (admin-allowed exceptions) trigger the `deepteam` job unconditionally. AC-B2.1 passes.

### Task B.05 — Wire critical-severity exit-non-zero gate (REQ-B3)
**REQ**: REQ-B3
**AC**: AC-B3.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: B.03
**Success criterion**: When DeepTeam reports any finding with `severity: critical`, the workflow step exits non-zero, blocking the branch-protection gate. AC-B3.1 passes against the synthetic ASI01-failing fixture (B.09).

### Task B.06 — Wire medium/low surfacing as PR comment + artifact (non-blocking, REQ-B4)
**REQ**: REQ-B4
**AC**: AC-B4.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: B.03, B.05
**Success criterion**: Medium/low findings are surfaced as a PR comment AND uploaded as an artifact; the workflow exits 0 and the PR remains mergeable. AC-B4.1 passes.

### Task B.07 — Wire budget-brake interrupt path (REQ-B5)
**REQ**: REQ-B5
**AC**: AC-B5.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: B.01, B.05
**Success criterion**: When `cost-controls/budget.yml` `red_team.per_run_usd` is set below the typical framework cost (e.g., `0.05`), DeepTeam is interrupted, `budget-exhausted.md` is uploaded as an artifact, and the workflow exits non-zero with the message `Red-team run halted by budget brake`. AC-B5.1 passes.

### Task B.08 — Wire artifact upload `deepteam-{run-id}` (REQ-B6)
**REQ**: REQ-B6
**AC**: AC-B6.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: B.05
**Success criterion**: The completed workflow run produces an artifact named `deepteam-{run-id}` containing `report.md`, `findings.jsonl`, `transcript.jsonl` with 90-day retention. AC-B6.1 passes.

### Task B.09 — Author synthetic ASI01-failing fixture + documentation-only fixture
**REQ**: REQ-B1, REQ-B3
**AC**: AC-B1.2 (docs-only skip), AC-B3.1 (ASI01 critical-fail)
**Type**: test
**Effort**: ~60–75 min (revised from ~45 min per Step 3 reviewer; the synthetic ASI01-failing Python harness needs an agent code path realistic enough for DeepTeam to genuinely classify as a critical finding)
**Depends on**: B.03
**Success criterion**: Both fixtures load deterministically. The ASI01 fixture (a thin Python harness whose agent code path intentionally exhibits goal-hijacking on the canonical probe) causes the CI job to exit non-zero. The docs-only fixture changes only `docs/**` paths and the job is skipped.

### Task B.10 — SHA-pin every `uses:` reference in the workflow (REQ-B8 / AST08)
**REQ**: REQ-B8
**AC**: AC-B8.1
**Type**: security-review
**Effort**: ~30 min
**Depends on**: B.03
**Success criterion**: Every `uses:` entry in `.github/workflows/security-scan.yml` references a 40-character commit SHA, not a tag or branch name. AC-B8.1 passes. Pinned SHA + the corresponding human-readable version captured in a YAML comment for future audit.

### Task B.11 — Security-review: NFR-B1 wall-clock cap + ASI07 resource-exhaustion defense
**REQ**: NFR-B1, NFR-B3
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~30 min
**Depends on**: B.03 – B.08
**Success criterion**: Workflow declares `timeout-minutes: ≤ 20` (auto-cancel at hard wall-clock cap). The combination of budget brake (REQ-B5) + wall-clock cap (NFR-B1) closes the ASI07 attack path documented in threat model B (a malicious PR crafting an agent that loops indefinitely under red-team probes). Review checklist signed.

### Task B.12 — Security-review: confirm no external network exposure of the agent-under-test endpoint (NFR-B3)
**REQ**: NFR-B3
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~20 min
**Depends on**: B.03
**Success criterion**: The agent-under-test endpoint is reachable only from the workflow runner's local network namespace; no external listener is opened. Confirmed by inspecting the job's network-related steps (no `runs-on` with public ingress; no port-forwarding).

### Task B.13 — Emit per-REQ Phase 4 implementation claims (B1–B8)
**REQ**: meta — consolidates Step 4 claim emission for area B
**AC**: all B ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: B.01 – B.12
**Success criterion**: 8 new claim YAML files (one per REQ-B1 through REQ-B8) all valid per the claim-validator's re-run check.

## Dependency graph

```
B.01 ─► B.02 ─► B.03 ─┬─► B.04
                      ├─► B.05 ─┬─► B.06
                      │         ├─► B.07
                      │         └─► B.08
                      ├─► B.09 (fixtures) ─► (feeds AC-B3.1 / AC-B1.2)
                      ├─► B.10 (sec-review)
                      ├─► B.11 (sec-review)
                      └─► B.12 (sec-review)
                                              │
                                              ▼
                                            B.13 (test — emit claims)
```

B.05 fans out to B.06/B.07/B.08 (all gating-or-surfacing behaviours layer on the critical-severity exit gate). B.09 is the fixture authoring that gates AC-B3.1 + AC-B1.2 validation. Security-reviews (B.10, B.11, B.12) run in parallel against the workflow-as-authored.

## Total effort estimate

- Implementation tasks (B.01, B.02, B.03, B.04, B.05, B.06, B.07, B.08): ~4.0 hours
- Security-review tasks (B.10, B.11, B.12): ~1.25 hours
- Test/fixture tasks (B.09, B.13): ~1.25 hours
- **Grand total: ~6.5–7.0 hours of Step 4 implementation work for area B.**

## Out of scope for this plan

- Static-scan portion of `security-scan.yml` (semgrep, gitleaks history scan, dependency audit) — existing tier-2 plus area A.
- Stack-specific red-team variants (Next.js-, Stripe-specific) — Phase 4 or area D extensions.
- Severity threshold change (blocking on `high`, not just `critical`) — deferred to v0.2.x per spec B Decisions.
- Local parity script in POSIX bash — CI is Linux.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area B plan decomposition).
- 2026-05-23 miltonadina: updated B.09 effort estimate 45 → 60-75 min per Step 3 reviewer (carry-forward note, not a structural revision — the original estimate underbudgeted the ASI01 fixture authorship).
