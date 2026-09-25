# File-based memory

The simplest tier. Markdown files committed to git in a project's
`.workflow/memory/`; this directory holds the starter files.

## Files

- `decisions.md` — durable architectural decisions. Each entry has date + author.
- `architecture.md` — current shape of the system; updated when shape changes.
- `glossary.md` — project-specific terms with definitions.
- `facts/` — anything that doesn't fit above. One topic per file.

## When to write

Every time:
- The user (or agent) makes a non-obvious choice with future implications
  → `decisions.md` (or write a full ADR in `docs/decisions/`)
- The architecture shifts (new service, new boundary, new data flow)
  → `architecture.md`
- A new domain term is introduced ("session," "tenant," "claim")
  → `glossary.md`

## Loaded by

No hook reads these files; `hooks/universal/session-start/load-baton.sh` does
not open them. Read them at session start when the project has them.

## Format

Each entry is a markdown section with a header containing date and one-line
summary:

```markdown
## 2026-05-22 — Argon2id for password hashing (Milton)

Chose Argon2id (work factor 3) over bcrypt because:
- OWASP recommendation as of 2025
- Better GPU resistance
- Memory-hard

See ADR-0012 for full alternatives analysis.
```
