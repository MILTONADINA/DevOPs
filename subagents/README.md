# Subagents

Eight role definitions: the six graph-pipeline roles below, plus the parked
`integrations-curator` and `librarian` (see `governance/graph/role-mapping.md`).
For read-only investigation, use Claude Code's native Explore agent.

| Subagent | Role | Writes to |
|----------|------|-----------|
| planner | Decompose spec into tasks | plans, blockers |
| coder | Implement tasks per plan | src/, tests/, proofs/ |
| tester | Write and run tests | tests/, proofs/ |
| reviewer | Diff analysis vs spec | review-comments, blockers |
| security | Tiered scan + interpretation | security-findings, blockers, proofs/ |
| validator | Final independent verification | validation-report, session-summary |

Models: `.claude/workflows/sprint-cycle.js` sets the model and effort on each
`agent()` call (Sonnet for every pipeline role). A file's `model:` field applies
only when the file is installed as a Claude Code agent. The routing record is
`cost-controls/model-routing.yml`.

## Permission model

Each subagent file declares a `permissions.write_paths` allowlist and a
`permissions.forbidden_paths` blocklist. They document each role's intended
scope, but nothing enforces them today: Workflow `agent()` calls take no path
allowlist, and Claude Code agent definitions do not read a `permissions:` key.
The enforced boundaries are the PreToolUse hooks a checkout wires (in this
repository, `.claude/settings.json`).

Per-subagent path scoping is the intended OWASP ASI03 (Identity and Privilege
Abuse) mitigation; it is not yet enforced.

## Adding a new subagent

1. Create `subagents/universal/<name>.md` with YAML frontmatter
2. Define `model`, `tools`, `permissions`
3. Document responsibilities, output format, and what the subagent does NOT do
4. Add to `cost-controls/model-routing.yml`
5. Add it to the `subagents` list in `analyzer/scan.ts` if the analyzer should recommend it
