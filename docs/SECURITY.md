# Security

## Threat model baseline

OWASP Top 10 for Agentic Applications 2026 (released Dec 2025). Every
project's threat model uses `templates/threat-model/STRIDE_ASI_TEMPLATE.md`.

## Tiered scan stack

| Tier | When | Tools | Gate |
|------|------|-------|------|
| 1 | every file write | gitleaks (post-tool hook) | hard block on findings |
| 2 | every PR | semgrep + npm/pip/cargo audit + axe-core | block merge on critical |
| 3 | pre-release | full history scan, Trivy, Nuclei, ZAP, DeepTeam | block release on critical |

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

All four are scoped to the `security` subagent per `subagents/universal/security.md`
— planner/coder/researcher subagents are denied at the hook layer (ASI02 +
ASI03 defense). All four reference credentials by env-var name only — no
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

Email the maintainer directly. Do not open a public issue.

## See also

- `governance/owasp-asi-2026/threats.md` — full ASI 2026 reference
- `docs/OWASP_ASI_THREAT_MODEL.md` — modeling guide
