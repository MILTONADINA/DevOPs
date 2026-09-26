# Security

## Threat model baseline

OWASP Top 10 for Agentic Applications 2026 (released Dec 2025). Every
project's threat model uses `templates/threat-model/STRIDE_ASI_TEMPLATE.md`.

## Tiered scan stack

This is what runs today (2026-09-25). The design goal is in the "Planned" column; it is not
enforced until it moves left.

| Tier | When | Runs today | Gate today | Planned, not wired |
|------|------|------------|------------|--------------------|
| 1 | every file write | nothing automatic: `hooks/universal/post-tool/gitleaks-scan.sh` exists but is not wired in `.claude/settings.json` | none | wire the post-tool hook (masterpiece roadmap MR-19 adds a staged-diff pre-commit gitleaks) |
| 2 | every PR | gitleaks (diff) and Semgrep (`p/owasp-top-ten`, `p/r2c-security-audit`, `p/secrets`) in `security-scan.yml` | both are required status checks on `main` and fail on any finding (Semgrep since #178) | npm/pip/cargo audit, axe-core |
| 3 | daily and pre-release | gitleaks full-history scan (scheduled, `.gitleaksignore` baseline); DeepTeam red-team, which skips when no provider key is set | the history scan fails its run on a leak; DeepTeam gates nothing while it skips | Trivy, Nuclei, ZAP (roadmap MR-21) |

### Tier-3 LLM-orchestrated pentest

Beyond the static tier-3 scanners, DevOPs ships configurations for four
LLM-orchestrated pentest tools that the security subagent invokes when a
project's compliance scope (PCI DSS / HIPAA / COPPA) or non-empty auth surface
warrants deeper assessment. The analyzer's recommendation rule
(`analyzer/scan.ts`) surfaces all four in `recommended.mcp_servers` when those
conditions are met (REQ-A5 / AC-A5.1):

| Tool | Role | MCP config | Per-tool README |
|------|------|------------|------------------|
| **Shannon** | Pentest-LLM orchestrator (top-level coordinator) | [`mcp-configs/universal/shannon.json`](../mcp-configs/universal/shannon.json) | [`shannon-README.md`](../mcp-configs/universal/shannon-README.md) |
| **PentAGI** | Autonomous agent for long-running scan workflows | [`mcp-configs/universal/pentagi.json`](../mcp-configs/universal/pentagi.json) | [`pentagi-README.md`](../mcp-configs/universal/pentagi-README.md) |
| **Lyrie** | RAG-based vulnerability research assistant | [`mcp-configs/universal/lyrie.json`](../mcp-configs/universal/lyrie.json) | [`lyrie-README.md`](../mcp-configs/universal/lyrie-README.md) |
| **pentest-ai** | MCP server exposing nmap / nuclei / sqlmap / ZAP CLI | [`mcp-configs/universal/pentest-ai.json`](../mcp-configs/universal/pentest-ai.json) | [`pentest-ai-README.md`](../mcp-configs/universal/pentest-ai-README.md) |

`subagents/universal/security.md` scopes all four to the `security` role, but nothing
enforces that scoping today: no hook denies them to other roles, the pipeline runs its roles
as Workflow agents with inline prompts, and none of the four MCP servers is registered in this
checkout (`specs/graph/M-masterpiece-standard.md` REQ-M27). All four reference credentials by
env-var name only — no
inline credentials (REQ-A8, gated by tier-1 gitleaks). Lyrie's output
specifically MUST pass through area C's `external-content-boundary.ts` before
re-entering agent context (ASI04 defense).

Upstream-maintenance verification cadence for the four tools is captured at
[`.workflow/maintenance/upstream-verify.md`](../.workflow/maintenance/upstream-verify.md)
(template; cadence enforcement deferred to Phase 3 or later per threat model A
ASI03 row).

Full threat-model context: [`docs/threat-models/phase-2/A-pentest-stack.md`](threat-models/phase-2/A-pentest-stack.md).

## Skills

- `security/owasp-asi-threat-model` — STRIDE + ASI 2026 modeling
- `security/prompt-injection-defense` — content sanitization
- `security/gitleaks-scan` — secret detection
- `security/semgrep-scan` — static analysis
- [`security/webhook-idempotency`](../skills/universal/security/webhook-idempotency/SKILL.md) — idempotency-key + replay-window + dedupe-storage discipline for webhook receivers (ASI02 Tool Misuse defense; universal across Stripe / GitHub / Slack / Twilio / SendGrid)

## Red team

Run `deepteam` with `OWASP_ASI_2026()` framework before any release that
changes agent behavior:

```python
from deepteam import red_team
from deepteam.frameworks import OWASP_ASI_2026
result = red_team(model_callback=your_agent, framework=OWASP_ASI_2026())
```

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it through GitHub
private vulnerability reporting:
<https://github.com/MILTONADINA/DevOPs/security/advisories/new>. Only the
maintainer can read the report.

**Owner action required.** Private vulnerability reporting is a repository
setting, and it was disabled on 2026-09-26. The repository owner must enable
it (repository Settings → Code security → Private vulnerability reporting)
before this link accepts reports. Until it is enabled, open an issue at
<https://github.com/MILTONADINA/DevOPs/issues> that asks for a private channel
and contains no vulnerability details.

This policy covers the whole repository, including Stratum (`stratum/`).
`stratum/SECURITY_POLICY.md` points here for the reporting channel.

Include in your report:

- a description of the vulnerability
- steps to reproduce
- the potential impact
- any proof-of-concept code, if you have it

### Scope

DevOPs runs on the user's own machine. There is no hosted service to test.

In scope:

- the Stratum proxy: authentication bypass, API-key handling, token
  injection, data exfiltration
- memory stores: access to one organization's data from another organization
- API endpoints: authorization flaws, IDOR, injection
- safety hooks and gates in `hooks/` and `.claude/settings.json`: a way to
  bypass a hook that is wired and claims to block an action
- the claim validator and proof ledger (`verification/`): a way to get a
  false claim accepted
- skill signing and provenance: a way to install a tampered skill without
  detection

Out of scope:

- vulnerabilities in third-party services or tools (LLM providers, Supabase,
  Docker, GitHub). Report those to the vendor.
- vulnerabilities in dependencies. Report those to the dependency's
  maintainer, and tell us so the dependency can be updated here.
- hooks that this document or `CLAUDE.md` lists as not wired
- denial of service by resource exhaustion on your own machine
- social engineering

### Good-faith research

We will not take legal action against anyone who researches and reports in
good faith under this policy: who reports promptly, does not access or change
other people's data beyond what is needed to show the issue, does not exploit
it for personal gain, and gives the maintainer a reasonable time to fix it
before disclosing it publicly (90 days from acknowledgement). Reporters are
credited in the advisory unless they prefer to stay anonymous.

## See also

- `governance/owasp-asi-2026/threats.md` — full ASI 2026 reference
- `docs/OWASP_ASI_THREAT_MODEL.md` — modeling guide
