# PentAGI — Autonomous Pentest Agent MCP

Config: [`pentagi.json`](./pentagi.json)

## Purpose

PentAGI is an autonomous pentest agent for **long-running scan workflows** —
multi-step assessments that would exceed a single Shannon-orchestrated session
(slow vulnerability sweeps, time-windowed traffic captures, multi-phase
reconnaissance). The defining characteristic vs. Shannon: PentAGI takes its
own decisions across the run rather than each step gating on the upstream
LLM's next prompt. That autonomy is the source of its leverage AND the source
of its threat surface — ASI07 (Resource Exhaustion) is the primary concern
per `docs/threat-models/phase-2/A-pentest-stack.md`.

## Auth

| Variable | Required | Purpose |
|----------|----------|---------|
| `PENTAGI_API_KEY` | yes | PentAGI platform API token |
| `PENTAGI_AUTHORIZED_SCOPE` | yes | Authorization boundary — MUST match `.workflow/client/profile.yml` per Constitution P7 |

The `_AUTHORIZED_SCOPE` discipline is identical to Shannon's; the scope env-var
names are distinct so a project can authorize one tool without authorizing the
others.

## Example invocation

```
pentagi.start({
  target: process.env.PENTAGI_AUTHORIZED_SCOPE,
  workflow: "owasp-top-10-2026",
  max_wallclock_minutes: 30,
  max_usd: 1.00
})
```

**Wall-clock and budget brakes are mandatory.** PentAGI's autonomy means a
naively configured run can burn compute indefinitely; ASI07 defense is
realized through `cost-controls/budget.yml` `red_team.per_run_usd` (production
default `0.50` per spec B REQ-B5) AND a per-invocation max-wallclock. A run
that hits either brake is recorded as `budget_exhausted` or `wallclock_exceeded`
in the result and exits non-zero.

## Upstream

Forward-looking integration. The upstream package and URL will be confirmed
at v0.2.0 release via the upstream-maintenance verification cadence (task A.12).
DevOPs-side MCP wrapper package `@miltonadina/pentagi-mcp` is reserved.

Threat-model context (ASI07 Resource Exhaustion + ASI02 Tool Misuse): see
`docs/threat-models/phase-2/A-pentest-stack.md`.
