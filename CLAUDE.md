# CLAUDE.md — Claude Code adapter for DevOPs

Claude Code reads `CLAUDE.md` on session start. This file sources `AGENTS.md`
(the universal contract) and adds Claude Code-specific bindings.

---

## First action

**Read `AGENTS.md` in this directory now.** It contains the universal contract
that applies to every coding agent including Claude Code. Everything below is
Claude Code-specific augmentation.

---

## Claude Code specific bindings

### Skills location

DevOPs skills are at `~/DevOPs/skills/universal/` and project-local
`.claude/skills/`. Skills are discovered automatically by Claude Code.

### Plugin manifest

DevOPs is installed as a plugin via `.claude-plugin/plugin.json`. To install
in any project:

```bash
/plugin install devops
```

### Hooks

Claude Code hooks are configured via `.claude/settings.json`. The DevOPs
installer wires the universal hooks from `~/DevOPs/hooks/universal/` into
your project automatically.

Project-specific hooks added Session 14:

- `hooks/universal/pre-tool/block-sealed-refs.sh` — blocks destructive git operations against sealed refs (v0.2.0 tag, archival branches). Returns exit 2 with explanation on attempt. References blueprint §3.
- `hooks/universal/post-tool/sync-lr-refined-date.sh` — auto-bumps `docs/LAUNCH_READINESS.md` "Last refined" date when `plan.md` is edited. Light-touch: date only, never the math sections. References blueprint §11.1 refresh triggers.

### Slash commands

DevOPs ships with these slash commands:

- `/checkpoint` — write the baton for tool handoff
- `/resume` — load the baton and continue
- `/security-scan` — run the tiered security scan suite
- `/verify-claims` — re-run the claim validator on the current session
- `/session-summary` — generate the end-of-session report
- `/threat-model` — produce a STRIDE + OWASP ASI 2026 threat model
- `/ears-spec` — convert prose requirements into EARS-formatted specs
- `/analyze` — re-run the project analyzer
- `/launch-readiness` — produce the canonical launch-readiness table set from markdown source-of-truth (see `slash-commands/universal/launch-readiness.md`)
- `/borrow-idea` — research a URL/repo/feature; propose blueprint+plan delta with version assignment + effort estimate (Ideas → Artifacts workflow per blueprint §11)
- `/emit-claim` — wrap the spec → check → log → YAML → validator → commit ritual for cleaner claim emission

**Anti-fabrication binding for status reporting**: Whenever the user asks for "status", "launch readiness", "where are we", "give me a report", or invokes `/launch-readiness` — the response MUST be derived from `blueprint.md` + `plan.md` + `docs/LAUNCH_READINESS.md` + `.workflow/state/{baton,session-handoff,polish-backlog}.md` + live git/gh outputs. Never fabricate figures, version-progress numbers, validator counts, or polish-backlog states. See `blueprint.md §11.1` for the canonical format + anti-fabrication rule.

### Subagent roles

DevOPs ships nine universal subagents. Spawn them via the Task tool:

- `planner` — reads spec, decomposes into atomic tasks; never writes code
- `researcher` — investigates codebase, external docs, prior decisions
- `coder` — executes one atomic task at a time, surgical edits only
- `tester` — writes/runs tests, produces proof artifacts
- `reviewer` — reads diffs against spec + principles, blocks on violations
- `security` — runs the tiered scan stack, blocks on findings above threshold
- `validator` — independent final check; re-runs all proofs, signs the summary
- `integrations-curator` — autonomous Ideas → Artifacts workflow executor (research URL → propose blueprint+plan delta with version + effort)
- `librarian` — Phase 3 memory-query subagent (CONTRACT placeholder until v0.5.x; reads-only against Stratum's three-tier memory)

Each subagent has its own permission scope (see `subagents/universal/*.md`).

### Model routing

`cost-controls/model-routing.yml` is loaded at session start. Default routing:

- Planner subagent → Opus 4.7 (architecture decisions)
- Researcher subagent → Haiku 4.5 (read-heavy, low-reasoning)
- Coder subagent → Sonnet 4.6 (the workhorse)
- Tester subagent → Haiku 4.5 (test execution; little reasoning)
- Reviewer subagent → Sonnet 4.6 (diff analysis)
- Security subagent → Sonnet 4.6 (scan interpretation)
- Validator subagent → Opus 4.7 (independent re-verification)

Override per session by editing `cost-controls/model-routing.yml`.

### Extended thinking

For complex architectural decisions, the Planner subagent should use extended
thinking with `xhigh` effort. For Opus 4.7, this is the default. For all other
work, default thinking is sufficient.

### Memory

The Stratum proxy (if configured) intercepts Claude Code calls. To enable:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
```

Stratum will prune context using the CQ-Extended KadaneDial algorithm (when
Phase 2 is complete) and log structured facts to its Supabase fact tables.

For semantic temporal queries, Zep is available via the
`@agentmemory/zep` MCP server. See `memory/zep/README.md`.

---

## Local additions

For per-machine settings or experiments, create `.claude/local.md`. It is
gitignored and loaded automatically by Claude Code.
