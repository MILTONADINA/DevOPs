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
| Codex CLI | `AGENTS.md` + `.codex/AGENTS.md` | SKILL.md (since v0.42) |
| Cursor | `.cursorrules` (generated from AGENTS.md) | inline rules |
| Antigravity | `AGENTS.md` | SKILL.md (since v1.0) |
| Kiro | `AGENTS.md` + steering files | SKILL.md (since launch) |
| Gemini CLI | `GEMINI.md` (generated) | inline |
| Copilot | `.github/copilot-instructions.md` | inline |
| Windsurf | `.windsurfrules` (generated) | inline |
| Aider | `CONVENTIONS.md` (generated) | inline |
| OpenCode | `CLAUDE.md` (compatible) | SKILL.md |

---

## Failover triggers

1. **Hard limit hit**: Claude Code 5-hour usage cap, Codex turn limit, etc.
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

- **OpenCode** with `qwen2.5-coder:32b` or `deepseek-coder-v2`
- **Aider** with `ollama/codestral` or `lmstudio/yi-coder`
- **Continue.dev** for IDE-integrated local agents

The `.workflow/state/budget-ledger.jsonl` triggers an automatic suggestion to
fail over to local when the daily cap is approaching.

---

## Capability matrix (when to pick which tool)

| Need | Best tool |
|------|-----------|
| Spec-driven work with EARS | Kiro, Claude Code |
| Multi-agent orchestration | Antigravity, Claude Code (subagents) |
| Browser automation (visual) | Claude Code + Playwright MCP, Antigravity |
| Long-running refactor | Claude Code (Sonnet+Opus tiers) |
| Quick edit, free | Cursor (free tier), Gemini CLI |
| Local/offline | OpenCode, Aider with Ollama |
| GitHub PR automation | Codex CLI, Copilot |
| Enterprise / regulated | Kiro (AWS-native), Claude Code (audit logs) |

---

**This skill is working when:** users can switch tools mid-project without
losing context. Track resume-after-switch success in
`governance/telemetry/resume-success.jsonl`.
