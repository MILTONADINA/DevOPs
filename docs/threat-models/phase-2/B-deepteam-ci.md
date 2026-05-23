# Threat Model — Phase 2 Area B — OWASP ASI 2026 Red-Team in CI (DeepTeam)

**Spec**: `specs/phase-2/B-deepteam-ci.md`
**Date**: 2026-05-22
**Author**: miltonadina (Claude Code, Opus 4.7)
**Reviewer**: miltonadina
**Status**: draft

---

## System sketch

```
PR contributor
    │
    ▼ git push  [TRUST BOUNDARY — contributor ↔ GitHub repo]
    GitHub repository (main + feature branches; branch protection on main)
    │
    ▼ on PR opened/sync, paths: skills/**, hooks/**, subagents/**,
    │ constitution/**, mcp-configs/**, analyzer/**, governance/owasp-asi-2026/**
    │ [REQ-B1 paths filter — scopes the trigger to agent-behavior PRs]
    │
    GitHub Actions runner (isolated, ephemeral)
    │
    ▼ python -m deepteam --framework OWASP_ASI_2026
    DeepTeam framework
    │
    ▼ adversarial probes per ASI01-ASI10 category
    Agent-under-test fixture (Python harness invoking project agent code path)
    │
    ▼ findings.jsonl + report.md + transcript.jsonl
    Workflow artifact upload (90-day retention)
       + PR comment with highest-severity finding
       + merge-block on `severity: critical` (REQ-B3)
```

The red-team gate runs externally to the agent. The agent cannot reason itself out of failing — by design (spec context).

## Trust boundaries

1. **PR contributor → GitHub repo** [TRUST BOUNDARY] — branch protection on `main` (Phase 1 ship); contributor commits are subject to PR review.
2. **GitHub Actions runner → agent fixture** [TRUST BOUNDARY] — runner is isolated and ephemeral; agent fixture is a sandboxed Python harness with no real tool wiring.
3. **DeepTeam → agent fixture** [TRUST BOUNDARY — *intentional* adversarial probes] — this IS the test, not a vulnerability. Probes are crafted to exercise ASI01–ASI10 categories.
4. **Workflow → artifact storage** [TRUST BOUNDARY] — 90-day retention; project-scoped GitHub artifact storage.
5. **Agent-under-test → red-team responses** [TRUST BOUNDARY] — the agent's responses to probes may leak system-prompt fragments *if* the agent is already compromised; redaction at log export.

## Data classes

| Class | Where stored | Where transmitted | Retention |
|-------|--------------|-------------------|-----------|
| Synthetic probe data | DeepTeam in-memory | runner-only | per workflow run |
| Agent response transcript | workflow artifact | GitHub artifact API | 90 days |
| Workflow logs | GitHub Actions logs | UI + API | per GitHub default (90 days) |
| Findings JSONL | workflow artifact + Langfuse (when configured) | telemetry sink | 90 days |
| `GITHUB_TOKEN` (workflow) | runner env | not exfiltrated | per-run; auto-revoked at run end |

---

## STRIDE analysis

| Threat | Description | Mitigation | Status |
|--------|-------------|------------|--------|
| **Spoofing** | Malicious PR author triggers workflow with a forged agent fixture that fakes compliance | Workflow runs in isolated runner; fixture path bounded by `paths:` filter (REQ-B1); fixture itself is committed by the PR and subject to review | spec'd |
| **Tampering** | PR modifies `.github/workflows/security-scan.yml` to disable the gate | SHA-pin all actions (REQ-B8); branch protection covers `.github/workflows/`; the workflow change itself is in `paths:` so it triggers the gate it would disable | spec'd (REQ-B8) |
| **Repudiation** | Who introduced the agent change that failed red-team? | GitHub PR audit log + commit author identity + claim artifacts per change | implemented (GitHub audit + Phase 1 claim discipline) |
| **Information disclosure** | Agent responses to probes leak system prompt or credentials | Synthetic probes only — no real credentials in scope; PII redaction at log export (reuses `observability/pii-redaction.ts`) | spec'd |
| **Denial of service** | Spam-flood of PRs triggers DeepTeam over and over to exhaust budget | Per-run budget cap `red_team.per_run_usd: 0.50` (REQ-B5); PR-scope filter excludes docs/deps/refactor (REQ-B1); wall-clock cap 20 min (NFR-B1) | spec'd |
| **Elevation of privilege** | Workflow runner gains elevated GitHub permissions | `GITHUB_TOKEN` scoped to `pull-requests: write` only; no `contents: write` or `actions: write` granted | spec'd |

---

## OWASP Top 10 for Agentic Applications (ASI) 2026

| ID | Threat | Applicable? | Description | Mitigation | Status |
|----|--------|------------|-------------|------------|--------|
| ASI01 | Agent Goal Hijacking | YES (this is the gate's primary subject) | DeepTeam's `OWASP_ASI_2026()` runs goal-hijacking probes against the agent fixture | The gate IS the mitigation: failures with `severity: critical` block merge (REQ-B3) | spec'd (this is the gate) |
| ASI02 | Tool Misuse | YES | Probes may attempt to elicit destructive tool calls from the agent | Agent fixture is sandboxed with no real tool wiring; probes test response shape, not real destructive paths | spec'd |
| ASI03 | Identity and Privilege Abuse | YES | Probes may attempt subagent privilege escalation | Per-subagent scopes preserved during probes (subagents/universal/*.md); fixture inherits the same scope discipline | implemented (Phase 1 scoping) |
| ASI04 | Indirect Prompt Injection | YES | Indirect-injection probes are a primary DeepTeam probe category | Tested by the gate; failures with critical severity block merge | spec'd |
| ASI05 | Memory Poisoning | N/A | The CI gate has no long-term memory; probes are stateless across runs | — | N/A |
| ASI06 | Inter-agent Communication Attacks | N/A | Probes target a single agent fixture; multi-agent attacks are out of scope for this gate | — | N/A |
| ASI07 | Resource Exhaustion | YES | A runaway probe agent could exhaust runner resources | Wall-clock cap 20 min hard (NFR-B1); per-run budget brake `0.50/run` (REQ-B5); workflow auto-cancels at the cap | spec'd |
| ASI08 | Recursive Hijacking | YES (this is the gate's primary subject) | DeepTeam probes reasoning-chain propagation as part of `OWASP_ASI_2026()` | The framework probes this; failures block | spec'd |
| ASI09 | Human-Agent Trust Exploitation | N/A | Probes do not interact with humans during the workflow run | — | N/A |
| ASI10 | Rogue Agents | YES | A compromised agent could game probes by detecting them (timing, prompt patterns) | DeepTeam's probe generator is non-deterministic per run; gate runs on every agent-touching PR (REQ-B1) plus push to main (REQ-B2) as defense-in-depth | spec'd |

---

## Open issues

> Block merge until resolved.

1. **Synthetic agent fixture for AC-B3.1** — the harness that intentionally fails an ASI01 probe is unauthored. Step 4 implementation should build a small library of canonical ASI-failing payloads per category. Not blocking Step 3 plan authoring; flagged so it's not lost.
2. **Documentation-only-PR fixture for AC-B1.2** — confirmed during Step 4; a docs-only commit must NOT trigger the gate. Trivial to author once the `paths:` filter lands.

---

## Sign-off

- [ ] Engineer: miltonadina — pending
- [ ] Security reviewer: miltonadina — pending
- [ ] Red-team scan (`deepteam OWASP_ASI_2026()`): self-referential — once spec B lands, the gate IS the scan
