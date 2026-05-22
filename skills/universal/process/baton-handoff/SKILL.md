---
name: baton-handoff
description: Write a complete handoff document at session end so the next agent (Claude Code, Codex, Cursor, Antigravity, Kiro, or local LLM) resumes exactly where this one stopped. Use whenever a session is approaching its limit, the user types /checkpoint, or the agent recognizes natural completion of a task. Surgical honesty - no context loss across tool boundaries.
---

# Baton Handoff

> Implements Principle 6 of the DevOPs Constitution.
> Sessions are short. Projects are long. The baton bridges the gap.

**Tradeoff:** ~500 bytes of structured state per session-end. Worth it: zero
context loss across tool boundaries.

---

## When to invoke

1. **User types `/checkpoint`** — explicit handoff request.
2. **Session limit approaching** — proactively, when 80%+ of session budget is used.
3. **Natural task boundary** — completed unit of work, no obvious next move.
4. **Before tool switch** — user mentions opening another agent.

---

## What goes in the baton

The hook `session-end/write-baton.sh` writes `.workflow/state/baton.md` with:

- `last_updated` timestamp
- `session_id` and originating tool
- Active `lifecycle_phase` and `active_mode`
- Git state (branch, HEAD, dirty file count)
- Count of verified claims this session
- List of open blockers
- **`next_action`** — the literal next instruction for the next agent
- Open questions for the user
- Files modified this session
- Recently completed claim refs

---

## How to write the next_action well

The single most important field. Be specific.

**Bad** (forces the next agent to re-explore):
> Continue working on auth.

**Good** (the next agent knows exactly what to do):
> Resume task T-014 (refresh-token rotation). The spec is at
> `specs/auth/tokens.md#ac-3`. AC-3, AC-4, AC-5 are implemented and verified
> (see `.workflow/proofs/claim-2026-05-22-018.yml` through `-020.yml`).
> AC-6 (clock-skew tolerance) is next.
>
> First action: read AC-6, write the failing test in `src/auth/clock-skew.test.ts`,
> then implement. Use the existing `addClockSkew` helper from
> `src/auth/util.ts` line 47.

---

## How to write open_questions

Anything the agent couldn't resolve alone. The user reads this when starting the
next session, answers, and the answers go into `specs/` or `decisions.md`.

```markdown
1. Should refresh tokens be invalidated on password change? (Currently they
   are NOT. AC-7 implies yes but doesn't say explicitly. Spec ambiguous.)

2. Rate limit on /refresh? Current setting: 30/min/IP. The compliance doc
   suggests 5/min/IP for OAuth-style refresh. Confirm which applies.
```

---

## Where the baton lives

- File: `.workflow/state/baton.md`
- Committed to git: yes, this is durable handoff state.
- Read by: `hooks/universal/session-start/load-baton.sh` on every session start.
- Max age before "stale": 24 hours (configurable). After that it's informational only.

---

## What NOT to put in the baton

- Code (the next agent has the repo)
- Lengthy reasoning (link to a doc instead)
- Anything secret (PII, keys) — these never go in committed files
- Past completed work in detail (link to proofs)

---

## Reading the baton

On session start, `load-baton.sh` already prints status. The agent must still
explicitly:

1. Open `.workflow/state/baton.md`
2. Read `next_action` and `open_questions`
3. Address blockers first
4. Then resume

---

**This skill is working when:** the user can type `continue` in any tool and
the agent picks up correctly. Track resume success in
`governance/telemetry/resume-success.jsonl`. Target: > 0.95.
