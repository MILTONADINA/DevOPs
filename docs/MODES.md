# Modes Reference

See `modes/README.md` for the overview. This doc is a quick reference.

## Switching modes

```bash
echo "hotfix" > .workflow/state/active-mode.txt
```

Next session-start hook reads it. Hooks and skills adjust their behavior.

## When to switch

| Situation | Mode |
|-----------|------|
| Starting a new project | greenfield |
| Default for existing code | brownfield |
| Moving from old to new tech | migration |
| Open production incident | hotfix |
| Changing structure, preserving behavior | refactor |
| Investigating prod issue | debug-prod |
| Reviewing without authority to fix | audit |
