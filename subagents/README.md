# Subagents

Seven universal subagents with distinct roles and least-privilege tool access.

| Subagent | Model | Role | Writes to |
|----------|-------|------|-----------|
| planner | opus | Decompose spec into tasks | plans, blockers |
| researcher | haiku | Read-only investigation | nothing |
| coder | sonnet | Implement tasks per plan | src/, tests/, proofs/ |
| tester | haiku | Write and run tests | tests/, proofs/ |
| reviewer | sonnet | Diff analysis vs spec | review-comments, blockers |
| security | sonnet | Tiered scan + interpretation | security-findings, blockers, proofs/ |
| validator | opus | Final independent verification | validation-report, session-summary |

## Permission model

Each subagent has a `permissions.write_paths` allowlist and a
`permissions.forbidden_paths` blocklist. The orchestrator enforces these
mechanically — the subagent cannot write outside its scope even if asked.

This implements OWASP ASI03 (Identity and Privilege Abuse) mitigation:
least-privilege per subagent.

## Cost model

The 3-tier model routing in `cost-controls/model-routing.yml` matches subagent
work shape:

- Opus for planning + validation (the bookends): rigorous reasoning where it
  matters most.
- Sonnet for the workhorse: coding, review, security interpretation.
- Haiku for mechanical tasks: research, test execution.

Documented savings: 50-80% vs. all-Sonnet baseline.

## Adding a new subagent

1. Create `subagents/universal/<name>.md` with YAML frontmatter
2. Define `model`, `tools`, `permissions`
3. Document responsibilities, output format, and what the subagent does NOT do
4. Add to `cost-controls/model-routing.yml`
5. Add to the recommendation rules in `analyzer/recommendation-rules.yml`
