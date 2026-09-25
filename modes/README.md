# Modes

Different operational rule sets per task type. The active mode is recorded in
`.workflow/state/active-mode.txt`. The session-start hook does not read it:
the agent does (AGENTS.md → Modes) and then follows `modes/<mode>/MODE.md`.

| Mode | When to use |
|------|-------------|
| greenfield | New project, no existing code to preserve |
| brownfield | Default for existing code; surgical edits, preserve behavior |
| migration | Moving from one tech to another with parallel-run |
| hotfix | Production-affecting bug; minimal scope, maximum safety |
| refactor | Preserve behavior, change structure; tests bookmark behavior |
| debug-prod | Investigate without changing; read-only by default |
| audit | Read-only review; produce findings document |

Each mode has a `MODE.md` with:

- **Purpose** — when to activate
- **Rule overrides** — what differs from defaults
- **Acceptance gates** — what must be true to exit

Switch modes via:
```bash
echo "hotfix" > .workflow/state/active-mode.txt
```

Then read `modes/<mode>/MODE.md` and follow it from that point; later
sessions pick the mode up from the file (AGENTS.md → Modes).
