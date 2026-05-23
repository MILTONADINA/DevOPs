# Phase 2 / Area B — OWASP ASI 2026 Red-Team in CI (DeepTeam)

**Spec ID**: phase-2/B-deepteam-ci
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

`docs/SECURITY.md` and `governance/owasp-asi-2026/threats.md` already declare that DeepTeam's `OWASP_ASI_2026()` framework is the red-team gate that runs before any release that changes agent behaviour. Phase 1 shipped the workflow file `.github/workflows/security-scan.yml` as scaffold. This spec hardens that scaffold into a working CI gate: DeepTeam runs on every PR and on push to `main`, critical findings block merge, results are uploaded as artifacts, and the red-team budget is bounded by `cost-controls/budget.yml`.

The red-team gate is the deterministic enforcement of the ASI 2026 threat model — the agent cannot reason itself out of failing it because the gate runs externally, in CI.

## Out of scope

- The static-scan portion of `.github/workflows/security-scan.yml` (semgrep, gitleaks history scan, dependency audit) — that is the existing tier-2 plus Phase 2 area A.
- Stack-specific red-team variants (Next.js-specific, Stripe-specific) — Phase 4.
- The MCP-orchestrated pentest tools — that is **area A**.
- Prompt-injection-specific runtime defense — that is **area C**. (B catches issues post-hoc in CI; C prevents them at runtime.)

## Actors and data

- **Primary actors**: CI runner (GitHub Actions), security-subagent (interprets findings locally), human reviewer (merge gate).
- **Data classes touched**: [x] none (red-team prompts are synthetic).
- **Compliance scope**: [x] none.

---

## Functional requirements (EARS)

### REQ-B1 (Event-driven) — DeepTeam runs on PR
WHEN a pull request is opened or updated against `main`, THE SYSTEM SHALL invoke DeepTeam with the `OWASP_ASI_2026()` framework against the agent under test and report results back to the PR.

### REQ-B2 (Event-driven) — DeepTeam runs on push to main
WHEN a commit is pushed directly to `main`, THE SYSTEM SHALL invoke DeepTeam against the agent under test and fail the workflow on critical findings.

### REQ-B3 (Unwanted behaviour) — Critical findings block merge
IF DeepTeam reports any finding with `severity: critical`, THEN THE SYSTEM SHALL exit the workflow with a non-zero status, causing the GitHub branch-protection gate to block the merge.

### REQ-B4 (Ubiquitous) — Medium/low findings are reported, not blocking
THE SYSTEM SHALL surface medium- and low-severity findings as PR comments and uploaded artifacts (markdown report, JSONL log) but SHALL NOT block the merge on them.

### REQ-B5 (Ubiquitous) — Red-team budget bounded
THE SYSTEM SHALL enforce a per-run red-team token budget configured in `cost-controls/budget.yml` under a new `red_team` section. If the budget is exhausted before the framework completes, the workflow records a `budget_exhausted` artifact and fails with a clear message.

### REQ-B6 (Ubiquitous) — Results uploaded as artifacts
THE SYSTEM SHALL upload the DeepTeam JSONL log, markdown report, and the agent's prompt/response transcript as GitHub Actions artifacts named `deepteam-{run-id}` with a 90-day retention.

### REQ-B7 (Ubiquitous) — Local invocation parity
THE SYSTEM SHALL provide a wrapper at `scripts/run-redteam.sh` (POSIX) so developers can reproduce the CI run locally before pushing. The wrapper reads the same budget config as CI.

### REQ-B8 (Ubiquitous) — Workflow file hash-pinned
THE SYSTEM SHALL pin every GitHub Action used in `security-scan.yml` to a commit SHA (not a tag) to defend against AST08 (skill/action update tampering) at the supply-chain layer.

---

## Acceptance criteria

### AC-B1.1 (maps to REQ-B1)
**Given** a feature branch with an agent-behaviour-changing commit
**When** a pull request is opened against `main`
**Then** a workflow run named `security-scan / deepteam` appears in the PR's checks list and completes within the configured budget.

### AC-B2.1 (maps to REQ-B2)
**Given** a direct push to `main` (admin-allowed exception)
**When** the push is processed
**Then** the `deepteam` job runs and its exit status determines the workflow's overall status.

### AC-B3.1 (maps to REQ-B3)
**Given** a synthetic agent fixture that intentionally fails an ASI01 (Goal Hijacking) probe
**When** the workflow runs against it
**Then** the workflow exits non-zero and the PR's `security-scan` check shows as failing.

### AC-B4.1 (maps to REQ-B4)
**Given** the same workflow with only medium/low findings
**When** the workflow runs
**Then** the workflow exits 0, the PR is mergeable, and the findings are visible in the PR comments and artifacts.

### AC-B5.1 (maps to REQ-B5)
**Given** a `cost-controls/budget.yml` `red_team.per_run_usd: 0.05` configured to a value below the framework's typical cost
**When** the workflow runs
**Then** the framework is interrupted, an artifact `budget-exhausted.md` is uploaded, and the workflow exits non-zero with the message `Red-team run halted by budget brake`.

### AC-B6.1 (maps to REQ-B6)
**Given** a completed workflow run
**When** the run's artifacts are inspected
**Then** an artifact named `deepteam-{run-id}` exists containing at least `report.md`, `findings.jsonl`, and `transcript.jsonl`.

### AC-B7.1 (maps to REQ-B7)
**Given** a developer-clone of the repo with DeepTeam installed locally
**When** `bash scripts/run-redteam.sh` is executed from the repo root
**Then** the script runs DeepTeam with the same framework and budget as CI and exits with the same status the CI run would.

### AC-B8.1 (maps to REQ-B8)
**Given** the post-implementation `.github/workflows/security-scan.yml`
**When** every `uses:` entry is inspected
**Then** each reference is a 40-character commit SHA, not a tag or branch name.

---

## Non-functional requirements

### NFR-B1 — Performance
- p95 workflow duration ≤ 12 minutes on a default GitHub-hosted runner.
- Hard wall-clock cap at 20 minutes; workflow auto-cancels.

### NFR-B2 — Observability
- DeepTeam JSONL log captured to artifact + ingested into Langfuse (when project has Langfuse configured) with `framework=OWASP_ASI_2026` baggage.
- Failing runs post a structured comment on the PR including the highest-severity finding's category and a link to the artifact.

### NFR-B3 — Security
- Threat model: `docs/threat-models/phase-2/B-deepteam-ci.md` (authored in Step 2).
- The agent-under-test endpoint is reachable only from the workflow runner; no external network exposure required.

### NFR-B4 — Compliance
- The synthetic red-team probes do not exercise real user data; artifacts may be uploaded without PII redaction overhead.

---

## Threat model

See `docs/threat-models/phase-2/B-deepteam-ci.md` (Step 2). Anticipated primary risks:

- **ASI07 (Resource Exhaustion)** — a malicious PR could craft an agent that loops indefinitely under red-team probes; mitigated by NFR-B1 wall-clock cap + REQ-B5 budget brake.
- **AST08 (Action update tampering)** — addressed by REQ-B8 (SHA-pin all actions).

---

## Decisions

- **Block on `critical` only, not `high`.** The ASI 2026 severity scale is multi-tier; blocking on `high` would create churn during early Phase 2 development. Severity threshold is configurable in a future v0.2.x.
- **Local parity script in POSIX bash, not PowerShell.** CI is Linux; developer parity should be on the same shell. Windows contributors run via Git Bash / WSL (already documented in `docs/HOOKS.md`).
- **Artifact retention 90 days.** Matches the validation report retention; longer than typical PR cycles, shorter than the audit-trail retention which lives in `events.jsonl`.

---

## Open questions

None blocking. The synthetic agent fixture for AC-B3.1 will be a thin Python harness invoking the project's actual agent code path — exact shape determined at implementation time.

---

## Implementation plan

Step 3 atomization will likely produce: (1) extend `cost-controls/budget.yml` with `red_team` section; (2) write `scripts/run-redteam.sh`; (3) modify `.github/workflows/security-scan.yml` to add the deepteam job; (4) author synthetic ASI01-failing fixture for AC-B3.1; (5) wire artifact upload + PR comment; (6) SHA-pin all actions.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-B1 | AC-B1.1 | (Phase 2 implementation) |
| REQ-B2 | AC-B2.1 | (Phase 2 implementation) |
| REQ-B3 | AC-B3.1 | (Phase 2 implementation) |
| REQ-B4 | AC-B4.1 | (Phase 2 implementation) |
| REQ-B5 | AC-B5.1 | (Phase 2 implementation) |
| REQ-B6 | AC-B6.1 | (Phase 2 implementation) |
| REQ-B7 | AC-B7.1 | (Phase 2 implementation) |
| REQ-B8 | AC-B8.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-018`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area B).
