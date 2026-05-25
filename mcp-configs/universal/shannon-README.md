# Shannon — Pentest-LLM Orchestrator MCP

Config: [`shannon.json`](./shannon.json)

## Purpose

Shannon is the top-level coordinator in the LLM-orchestrated pentest stack. It
drives an LLM through structured penetration-testing workflows, dispatching
discrete tasks to the lower-level tools (nmap, nuclei, ZAP, etc.) and folding
their outputs back into the next reasoning step. For DevOPs this is the
**entry point** for any LLM-driven assessment — the security subagent invokes
Shannon, not the underlying CLI tools directly.

## Auth

Environment variables (the JSON config references these by name; never inline
the values):

| Variable | Required | Purpose |
|----------|----------|---------|
| `SHANNON_API_KEY` | yes | Shannon platform API token |
| `SHANNON_AUTHORIZED_SCOPE` | yes | Authorization boundary (domains, IPs, CIDR ranges) — MUST match the `authorized_scope` declared in `.workflow/client/profile.yml` per Constitution P7 (Client Boundary Discipline) |

If `SHANNON_AUTHORIZED_SCOPE` is missing or empty, the agent SHALL refuse to
invoke Shannon. There is no fallback default — pentest scope is a deliberate,
written-authorization concern.

## Example invocation

The security subagent issues a request like:

```
shannon.assess({
  target: process.env.SHANNON_AUTHORIZED_SCOPE,
  framework: "OWASP-ASI-2026",
  budget_usd: 2.00
})
```

Wall-clock and dollar brakes (`cost-controls/budget.yml` → `red_team` section,
or per-invocation override) bound the run. Output is captured to
`.workflow/proofs/<claim-id>-shannon.log` if the assessment is wired to a
verifiable claim.

Per spec A NFR-A2: Shannon's MCP server runs with the least privileges its
task requires. `subagents/universal/security.md` scopes invocation to the
security subagent — planner/coder/researcher subagents are denied.

## Upstream

Forward-looking integration. The exact upstream package and URL will be
confirmed at v0.2.0 release via the upstream-maintenance verification cadence
authored under task A.12 (`.workflow/maintenance/upstream-verify.md`). The
DevOPs-side MCP wrapper package `@miltonadina/shannon-mcp` is reserved; the
JSON shape in `shannon.json` is the load-bearing contract this PR establishes.

Threat-model context (ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse):
see `docs/threat-models/phase-2/A-pentest-stack.md`.
