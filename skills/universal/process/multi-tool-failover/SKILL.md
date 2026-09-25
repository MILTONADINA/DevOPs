---
name: multi-tool-failover
description: Manage session continuity when switching between Claude Code, Codex CLI, Cursor, Antigravity, Kiro, or local LLMs (OpenCode, Aider). Use when approaching session limits, switching to a different tool's strengths, or when one tool fails and another must continue. Relies on the baton protocol and universal SKILL.md format.
---

# Multi-Tool Failover

> Sessions are tool-bound. Projects are not. The baton + universal skill format
> bridge any agent gap.

**Tradeoff:** Some tool-specific features are unavailable when the active tool
changes. Worth it: zero work loss when one tool runs out of context, hits a
limit, or has a bug.

---

## Supported tools and their adapters

| Tool | Entry file | Skills read |
|------|-----------|-------------|
| Claude Code | `CLAUDE.md` + `.claude/skills/` | SKILL.md (native) |
| Codex CLI | `AGENTS.md` + `.codex/AGENTS.md` | SKILL.md |
| Cursor | `.cursorrules` (write from AGENTS.md) | inline rules |
| Antigravity | `AGENTS.md` | SKILL.md |
| Kiro | `AGENTS.md` + steering files | SKILL.md |
| Gemini CLI | `GEMINI.md` (write from AGENTS.md) | inline |
| Copilot | `.github/copilot-instructions.md` | inline |
| Windsurf | `.windsurfrules` (write from AGENTS.md) | inline |
| Aider | `CONVENTIONS.md` (write from AGENTS.md) | inline |
| OpenCode | `CLAUDE.md` (compatible) | SKILL.md |

---

## Failover triggers

1. **Hard limit hit**: the active tool's usage cap, rate limit or turn
   limit. Caps vary by vendor plan; check the vendor's current plan page.
2. **Tool-specific bug**: agent gets stuck on a specific tool's quirk.
3. **Capability mismatch**: current task needs a feature the active tool lacks
   (computer use, browser, specific MCP).
4. **Cost optimization**: routine work moved to a local LLM via OpenCode.

---

## Failover protocol

### From current tool (sending side)

1. Invoke `baton-handoff` skill. Write `.workflow/state/baton.md`.
2. Commit any outstanding work-in-progress to a branch with a clear name
   (e.g., `wip/T-014-refresh-tokens`).
3. State in the session summary: "Handing off to [next-tool] for [reason]."
4. End session.

### To next tool (receiving side)

1. Open the project in the next tool.
2. Session-start hook fires; baton is detected.
3. Read `CLAUDE.md` (or relevant adapter file) and `AGENTS.md`.
4. Read `.workflow/state/baton.md`. Address blockers first.
5. Resume from `next_action`.

The next tool doesn't need to know the previous tool's specifics — the baton
is plain markdown.

---

## Local LLM fallback

For runaway-cost prevention or air-gapped work, route to a local LLM:

- **OpenCode** or **Aider** with a local coding model served by Ollama or
  LM Studio (the user picks the model)
- **Continue.dev** for IDE-integrated local agents

Nothing suggests this failover automatically. When the daily spend in
`.workflow/state/budget-ledger.jsonl` (kept where a budget hook is wired)
nears the cap, propose it to the user yourself.

---

## Capability matrix (when to pick which tool)

| Need | Best tool |
|------|-----------|
| Spec-driven work with EARS | Kiro, Claude Code |
| Multi-agent orchestration | Antigravity, Claude Code (subagents) |
| Browser automation (visual) | Claude Code + Playwright MCP, Antigravity |
| Long-running refactor | Claude Code |
| Quick edit | Cursor, Gemini CLI |
| Local/offline | OpenCode, Aider with Ollama |
| GitHub PR automation | Codex CLI, Copilot |
| Enterprise / regulated | Kiro, Claude Code |

The table names strengths, not plans or prices. Free tiers, usage caps, model
tiers and enterprise features such as audit logs change with vendor releases;
check the vendor's current plan page before relying on a row.

---

**This skill is working when:** users can switch tools mid-project without
losing context. Track resume-after-switch success in
`governance/telemetry/resume-success.jsonl`.
