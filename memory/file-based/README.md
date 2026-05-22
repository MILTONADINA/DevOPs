# File-based memory

The simplest tier. Markdown files committed to git.

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

`hooks/universal/session-start/load-baton.sh` reads the file-based memory on
every session start. It's the first thing the agent sees after the constitution.

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
