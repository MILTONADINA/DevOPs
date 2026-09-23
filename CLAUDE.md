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

DevOPs skills live in the project-local `skills/universal/` directory (there
is no `~/DevOPs/` install on this machine). Claude Code also auto-discovers
`.claude/skills/` if present.

### Plugin manifest

DevOPs is installed as a plugin via `.claude-plugin/plugin.json`. To install
in any project:

```bash
/plugin install devops
```

### Hooks

Claude Code hooks are configured via `.claude/settings.json`, which is
tracked in this repo and wires four hooks (since commit `3c81635`,
2026-09-14; hardened in `027c159`, 2026-09-15):

- SessionStart → `hooks/universal/session-start/graph-preflight.sh` —
  runs `scripts/graph-preflight.sh --check-only`, prints the check table,
  never applies a repair, and never blocks the session.
- PreToolUse on `Bash` → `hooks/universal/pre-tool/block-sealed-refs.sh` —
  blocks destructive git operations against sealed refs (the v0.2.0 tag,
  archival branches). Exit 2 with an explanation. References blueprint §3.
- PreToolUse on `Bash` → `hooks/universal/pre-tool/deploy-gate.sh` — the
  graph-engineering production/billing gate: deploy-shaped commands need a
  human approval marker, billing-path commits/pushes need two from distinct
  approvers, and `.workflow/state/graph-halt` halts everything consequential.
  See `governance/graph/` and SHIP_BLOCKERS.md 1.8.
- PostToolUse on `Write|Edit` → `hooks/universal/post-tool/sync-lr-refined-date.sh`
  — bumps `docs/LAUNCH_READINESS.md`'s "Last refined" date when `plan.md`
  is edited. Date only, never the math sections. References blueprint §11.1.

The wrappers in `settings.json` resolve the project root from
`CLAUDE_PROJECT_DIR` (git top-level as a warned fallback), `cd` there, and
invoke each hook via `bash` — so a `cd` into a subdirectory cannot lock the
session out and the hooks' own root-relative paths resolve correctly. They
fail **closed** (exit 2, which Claude Code treats as a block) if the root
cannot be resolved or a hook script is missing; a bare "HOOK … failing
closed" error on every Bash command therefore means the checkout is
broken, not that the gate logic is. Hook edits in `settings.json` are
picked up by the running session (verified 2026-09-15).

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
The underlying check is `npm run validate:claims`, which `/verify-claims`
wraps.

### Subagent roles

DevOPs ships eight universal subagents. Spawn them via the Task tool. (A
ninth, `researcher`, was removed 2026-09-14 as redundant with Claude Code's
native Explore agent type — use that for codebase/doc investigation instead.)

- `planner` — reads spec, decomposes into atomic tasks; never writes code
- `coder` — executes one atomic task at a time, surgical edits only
- `tester` — writes/runs tests, produces proof artifacts
- `reviewer` — reads diffs against spec + principles, blocks on violations
- `security` — runs the tiered scan stack, blocks on findings above threshold
- `validator` — independent final check; re-runs all proofs, signs the summary
- `integrations-curator` — autonomous Ideas → Artifacts workflow executor (research URL → propose blueprint+plan delta with version + effort)
- `librarian` — Phase 3 memory-query subagent (CONTRACT placeholder until v0.5.x; reads-only against Stratum's three-tier memory)

Each subagent has its own permission scope (see `subagents/universal/*.md`).

### Model routing

`cost-controls/model-routing.yml` is the routing record (user directive,
2026-09-14):

- Orchestrator ("boss/CTO" — the main session running
  `.claude/workflows/sprint-cycle.js`) → Fable 5.1, chosen by the user via
  `/model`; no config file can switch a running session's own model.
- Every graph-engineering subagent role (planner, coder, tester, reviewer,
  security, validator) → Sonnet 5 at **max** reasoning effort. This IS
  enforced: each `agent()` call in `sprint-cycle.js` passes
  `model: 'sonnet', effort: 'max'`.
- Haiku 4.5 and Opus 5 are listed in the file for reference/override only;
  nothing routes to them today.

Override per session by editing `cost-controls/model-routing.yml` and the
`model:`/`effort:` options in `sprint-cycle.js` together — the yml is
documentation, the script is the enforcement.

### Extended thinking

Every pipeline role already runs at max effort (above). Outside the
pipeline, default thinking is sufficient for routine work; reserve higher
effort for architecture decisions and adversarial verification passes.

### Memory

Stratum (`stratum/`) is this project's memory/gateway subsystem — one
project, not a separate product (it was merged in as a subtree specifically
so it would stop being one). Live, deployed (Fastify proxy + multi-provider
gateway + Supabase-backed 3-tier memory + CFO dashboard) — not a
hypothetical. See `stratum/` for current architecture; this file won't stay
current with it.

To route Claude Code calls through the local Stratum proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
```

(The Zep MCP backend for semantic temporal queries was removed 2026-09-14 as
unwired dead weight — see `memory/README.md` for why. That kind of query is
currently unsupported.)

---

## Local additions

For per-machine settings or experiments, create `.claude/local.md`. It is
gitignored and loaded automatically by Claude Code.
This is Claude-Code-only. For an override that should also apply to
Codex/Cursor, use `AGENTS.override.md` (defined in `AGENTS.md`) instead.
