---
name: owasp-asi-threat-model
description: Produce a STRIDE + OWASP Top 10 for Agentic Applications (ASI) 2026 threat model for any new feature, API, or system. Use whenever designing a feature that touches auth, data, agents, tools, or external inputs. Triggers on terms like "design", "architecture", "new endpoint", "new agent", "new MCP", or "security review". The ASI 2026 framework (released Dec 2025) is the industry standard for agentic AI security.
---

# OWASP ASI 2026 Threat Model

> STRIDE for the system. OWASP ASI 2026 for the agent. Both for any feature
> involving AI agents.

**Tradeoff:** Adds a design artifact before coding. Worth it: 48% of
cybersecurity pros rank agentic AI as the #1 attack vector for 2026, yet only
34% of enterprises have AI-specific controls. The threat model is the bridge.

---

## When to invoke

- New feature touching authentication, authorization, or session
- New API endpoint accepting external input
- New agent (or skill, subagent, MCP server)
- New tool the agent can invoke
- New data flow (storage, transmission, processing)
- Security review request

---

## The two frameworks combined

### STRIDE (classical software threats)

| Threat | Question |
|--------|----------|
| Spoofing | Can someone pretend to be a legitimate actor? |
| Tampering | Can data in transit or at rest be modified? |
| Repudiation | Can someone deny having done something? |
| Information disclosure | Can data leak to unauthorized parties? |
| Denial of service | Can the system be made unavailable? |
| Elevation of privilege | Can someone gain more permissions than intended? |

### OWASP Top 10 for Agentic Applications 2026 (ASI)

| ID | Threat | Question |
|----|--------|----------|
| ASI01 | Agent Goal Hijacking (#1 risk) | Can an adversary redirect the agent's objective via poisoned input? |
| ASI02 | Tool Misuse | Can the agent invoke a tool in a way that causes harm? |
| ASI03 | Identity and Privilege Abuse | Can the agent (or its delegated subagent) act with more privilege than required? |
| ASI04 | Indirect Prompt Injection | Can hidden instructions in documents, RAG content, or tool outputs alter behavior? |
| ASI05 | Memory Poisoning | Can persistent memory be corrupted to influence future sessions? |
| ASI06 | Inter-agent Communication Attacks | Can one agent be used to attack another (in multi-agent systems)? |
| ASI07 | Resource Exhaustion | Can the agent be induced into runaway cost or infinite loops? |
| ASI08 | Recursive Hijacking | Can goal modifications propagate through reasoning chains? |
| ASI09 | Human-Agent Trust Exploitation | Can the agent be socially-engineered into bypassing its constraints? |
| ASI10 | Rogue Agents | Can a compromised agent operate undetected? |

---

## Template

Use `templates/threat-model/STRIDE_ASI_TEMPLATE.md`. The structure:

```markdown
# Threat Model — <feature-name>

**Spec**: link
**Date**: YYYY-MM-DD
**Author**: <user>
**Reviewer**: <user>

## System sketch

<data flow diagram or prose: actors → entry points → trust boundaries →
data stores>

## Trust boundaries

1. <external clients> → <our API> [boundary]
2. <our API> → <internal services> [boundary]
3. <agent> → <tool> [boundary]
4. <agent> → <external content> [boundary] ← USUALLY MISSED

## STRIDE analysis

| Threat | Description | Mitigation | Status |
|--------|-------------|------------|--------|
| Spoofing | ... | ... | implemented |
| Tampering | ... | ... | spec'd |
| ... | ... | ... | ... |

## OWASP ASI 2026 analysis

| Threat | Applicable? | Description | Mitigation | Status |
|--------|------------|-------------|------------|--------|
| ASI01 Goal Hijacking | YES | RAG results from external docs entering context | Wrap untrusted content in `<external-content untrusted="true">` markers; instruct agent to treat as data | spec'd |
| ASI02 Tool Misuse | YES | Agent has access to file delete | Pre-tool hook blocks rm -rf outside whitelisted paths | implemented |
| ASI03 Identity & Privilege | YES | Subagent runs with parent's full credentials | Per-subagent scoped tokens with least privilege | spec'd |
| ASI04 Indirect Injection | YES | User uploads docs that are read by agent | All ingested content passes through prompt-injection-defense skill | spec'd |
| ASI05 Memory Poisoning | YES | Agent writes to long-term memory | Git-attestation cross-references stated facts against commits; conflicts written to audit_conflicts | implemented (Stratum) |
| ASI06 Inter-agent | YES | Multi-agent system | Subagent outputs validated by parent before propagating | spec'd |
| ASI07 Resource Exhaustion | YES | Agent can run unbounded | Budget brake + loop detection + scratchpad stasis hooks | implemented |
| ASI08 Recursive Hijacking | YES | Goal modifications propagate | Constitution layer is immutable per session; reads on every turn | implemented |
| ASI09 Human-Agent Trust | YES | Agent could be convinced to bypass rules | Hard hooks fire regardless of agent intent | implemented |
| ASI10 Rogue Agents | YES | Agent could operate covertly | All actions logged to events.jsonl; cost ledger reconciled daily | implemented |

## Open issues

<things that need decision before implementation>

## Sign-off

- Threat model reviewed by: <user> on <date>
- Security subagent scan: <link to claim artifact>
```

---

## Process

1. **Sketch the system**. Data flow diagram or prose. Where does input come
   from? Where does it go? What does it touch?

2. **Mark trust boundaries**. Every line crossing a boundary is a potential
   attack surface. The agent ↔ external content boundary is the one most
   commonly missed.

3. **For each STRIDE category**, ask the question. If applicable, document the
   mitigation. If not, write "N/A — [reason]."

4. **For each OWASP ASI 2026 category**, ask the question. ASI01 (Goal
   Hijacking) and ASI04 (Indirect Injection) almost always apply to anything
   touching an agent.

5. **Mitigations are linked**, not described. Point to the hook, skill, or
   code that implements them.

6. **Status field**: `implemented`, `spec'd`, `open`. Open items block merge.

---

## Common mitigation references

- ASI01 Goal Hijacking → `skills/universal/security/prompt-injection-defense`
- ASI03 Identity → `subagents/universal/*.md` (per-role permission scoping)
- ASI05 Memory Poisoning → `memory/stratum/` (git-attestation)
- ASI07 Resource Exhaustion → `hooks/universal/pre-tool/budget-brake.sh`,
  `loop-detection.sh`
- ASI09 Trust Exploitation → `hooks/universal/pre-tool/*` (hooks fire
  regardless of agent intent)

---

## Red-teaming

After the threat model is approved, run `deepteam` with the
`OWASP_ASI_2026()` framework against your agent:

```python
from deepteam import red_team
from deepteam.frameworks import OWASP_ASI_2026

result = red_team(
    model_callback=your_agent,
    framework=OWASP_ASI_2026()
)
```

This generates adversarial prompts for each ASI category and reports which
defenses held. Treat as a CI gate for any release that changes agent behavior.

---

**This skill is working when:** every PR touching agents, auth, or data has a
linked threat model, and the DeepTeam adversarial scan passes before merge.

## References

- OWASP Top 10 for Agentic Applications 2026 (released Dec 2025)
- OWASP Agentic Skills Top 10 (AST10) for skill supply-chain attacks
- Microsoft STRIDE methodology
- DeepTeam red-team framework
