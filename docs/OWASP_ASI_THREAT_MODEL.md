# OWASP ASI 2026 Threat Modeling Guide

See `skills/universal/security/owasp-asi-threat-model/SKILL.md` for the active
skill. See `governance/owasp-asi-2026/threats.md` for the full threat reference.

## Process

1. Sketch the system (data flow or prose)
2. Mark trust boundaries (especially agent ↔ external content — often missed)
3. For each STRIDE category, ask the question; document mitigation
4. For each ASI 2026 category, ask the question; document mitigation
5. Status field: `implemented`, `spec'd`, `open` — open items block merge

## Template

`templates/threat-model/STRIDE_ASI_TEMPLATE.md`

## When required

- New feature touching auth or session
- New API endpoint accepting external input
- New agent, skill, subagent, MCP server
- New tool the agent can invoke
- New data flow

## Red-team validation

Before any release that changes agent behavior:

```python
from deepteam import red_team
from deepteam.frameworks import OWASP_ASI_2026
result = red_team(model_callback=your_agent, framework=OWASP_ASI_2026())
```

Treat any successful injection or hijacking as P0.
