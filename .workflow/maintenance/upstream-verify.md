# Upstream-Maintenance Verification — Pentest Stack

**Template purpose**: structured per-upstream record for the four LLM-orchestrated
pentest tools the analyzer recommends (Shannon / PentAGI / Lyrie / pentest-ai-MCP).
This template is the **Phase 2 deliverable** for plan A task A.12; the **cadence
enforcement** (cron / governance escalation / PR auto-creation when an upstream
goes stale) is explicitly **deferred to Phase 3 or later** per the threat model A
ASI03 row in `docs/threat-models/phase-2/A-pentest-stack.md`.

The template addresses an honest concern: the four upstreams have varied
maintenance signals in 2025-2026. A recommendation set that quietly points at
abandoned upstreams is a slow-burn supply-chain failure (ASI03). This file is
the record-of-truth that an operator can sweep through quarterly (or whenever
the analyzer recommendation set is reviewed) to confirm each upstream remains
materially maintained.

---

## How to use

Walk the checklist below for each of the four upstreams, filling in the date
fields and signal observations. Replace the "TODO" placeholders. The template
is intentionally not self-updating — Phase 3 will add the automation; this
phase ships the record-keeping discipline.

When any upstream's signals collectively indicate abandonment (no commits in
6 months + no releases in 12 months + no responsive maintainer), the operator
SHALL surface the finding for downstream-project decisions: pin to a known-good
version, fork, or drop the tool from the analyzer's recommendation set entirely.
DO NOT silently keep an abandoned upstream in `analyzer/scan.ts`.

---

## Shannon

- **Role**: pentest-LLM orchestrator (top-level coordinator)
- **MCP config**: [`mcp-configs/universal/shannon.json`](../../mcp-configs/universal/shannon.json)
- **DevOPs-side wrapper package (provisional)**: `@miltonadina/shannon-mcp`
- **Upstream repository (TBD at v0.2.0)**: TODO — confirm canonical upstream URL
- **Last-commit-date (default branch)**: TODO — `YYYY-MM-DD`
- **Last-release-date**: TODO — `YYYY-MM-DD`
- **Maintainership signal**: TODO — pick one and annotate:
  - [ ] Actively maintained (commits in the last 90 days, responsive maintainer)
  - [ ] Slow-but-present (commits in the last 6 months)
  - [ ] Dormant (last commit > 6 months, no release > 12 months)
  - [ ] Abandoned (no maintainer activity / open issues unanswered)
- **Open-vulnerability count (CVEs against current pinned version)**: TODO
- **Operator notes**: TODO

---

## PentAGI

- **Role**: autonomous pentest agent for long-running scan workflows
- **MCP config**: [`mcp-configs/universal/pentagi.json`](../../mcp-configs/universal/pentagi.json)
- **DevOPs-side wrapper package (provisional)**: `@miltonadina/pentagi-mcp`
- **Upstream repository (TBD at v0.2.0)**: TODO — confirm canonical upstream URL
- **Last-commit-date (default branch)**: TODO — `YYYY-MM-DD`
- **Last-release-date**: TODO — `YYYY-MM-DD`
- **Maintainership signal**: TODO — pick one and annotate:
  - [ ] Actively maintained
  - [ ] Slow-but-present
  - [ ] Dormant
  - [ ] Abandoned
- **Open-vulnerability count**: TODO
- **Operator notes**: TODO

---

## Lyrie

- **Role**: RAG-based vulnerability research assistant
- **MCP config**: [`mcp-configs/universal/lyrie.json`](../../mcp-configs/universal/lyrie.json)
- **DevOPs-side wrapper package (provisional)**: `@miltonadina/lyrie-mcp`
- **Upstream repository (TBD at v0.2.0)**: TODO — confirm canonical upstream URL
- **Last-commit-date (default branch)**: TODO — `YYYY-MM-DD`
- **Last-release-date**: TODO — `YYYY-MM-DD`
- **Maintainership signal**: TODO — pick one and annotate:
  - [ ] Actively maintained
  - [ ] Slow-but-present
  - [ ] Dormant
  - [ ] Abandoned
- **RAG-corpus provenance check**: TODO — has the curated corpus been audited
  for attacker-curated content (ASI04 defense)? `YES / NO + date`
- **Open-vulnerability count**: TODO
- **Operator notes**: TODO

---

## pentest-ai-MCP

- **Role**: MCP server exposing nmap / nuclei / sqlmap / ZAP CLI
- **MCP config**: [`mcp-configs/universal/pentest-ai.json`](../../mcp-configs/universal/pentest-ai.json)
- **DevOPs-side wrapper package (provisional)**: `@miltonadina/pentest-ai-mcp`
- **Upstream repository (TBD at v0.2.0)**: TODO — confirm canonical upstream URL
- **Last-commit-date (default branch)**: TODO — `YYYY-MM-DD`
- **Last-release-date**: TODO — `YYYY-MM-DD`
- **Maintainership signal**: TODO — pick one and annotate:
  - [ ] Actively maintained
  - [ ] Slow-but-present
  - [ ] Dormant
  - [ ] Abandoned
- **Underlying-tool-versions pinned** (nmap / nuclei / sqlmap / ZAP CLI): TODO
- **Open-vulnerability count**: TODO
- **Operator notes**: TODO

---

## Verification log

Append one row per sweep. Operator initials + ISO date + a one-line summary.

| Date (UTC) | Operator | Summary |
|------------|----------|---------|
| TODO | TODO | Initial template authored 2026-05-23; all upstreams TBD pending v0.2.0 release validation |

---

## Phase 3+ deferred work

The following are intentionally NOT in scope this phase. Each requires the
broader Phase 3 memory + observability stack (Stratum + Zep) to operate
correctly:

1. **Cadence enforcement** — cron-driven scheduled sweep that opens an issue when
   any upstream's last-commit-date exceeds the configured threshold.
2. **Governance escalation** — when a sweep flags abandonment, automatically
   pause the analyzer's recommendation rule for that tool until an operator
   resolves the open issue.
3. **Telemetry** — log each sweep result to `governance/telemetry/upstream-verify.jsonl`
   for trend analysis.
4. **Auto-PR for recommendation-set updates** — when an upstream is confirmed
   abandoned, the system opens a PR to remove it from `analyzer/scan.ts` and
   the `mcp-configs/universal/` directory.

Until Phase 3 ships, this is a manual-discipline artifact. The discipline of
HAVING the record is itself the load-bearing Phase 2 defense — Phase 3 layers
automation on top of an honest record.
