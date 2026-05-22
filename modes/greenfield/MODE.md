# Greenfield Mode

## When to activate

- New project with < 5 commits OR no git history
- Stack and shape are still being chosen
- Team is open to architectural recommendations

## Rule overrides from defaults

- **Plan first, code second** — every feature starts with a plan even if tiny
- **EARS specs required** for everything beyond bootstrapping
- **ADR for every non-obvious choice** (database, framework, deploy target)
- **Snapshot the architecture** after the first 5 commits in `memory/file-based/architecture.md`
- **More permissive** on file creation outside existing patterns

## Acceptance gates to exit greenfield

- [ ] At least one deployed environment (dev or staging)
- [ ] `architecture.md` written
- [ ] First three ADRs filed
- [ ] First EARS spec implemented end-to-end with verified claim
- [ ] Threat model for public attack surface
- [ ] Lifecycle moves to `design` or `build`
