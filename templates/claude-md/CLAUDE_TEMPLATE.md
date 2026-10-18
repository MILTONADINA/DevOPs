# CLAUDE.md

Claude Code adapter for this project. The operating contract is in `AGENTS.md`.

## At session start

1. Read `AGENTS.md`.
2. Read the constitution it points to: {{constitution/PRINCIPLES.md}}, {{constitution/ANTIPATTERNS.md}} and {{constitution/LOOP.md}}.
3. If a recent baton file was written to `.workflow/state`, resume from its Next action section.

## What `devops init` installed here

- `AGENTS.md`: the contract above. Do not edit it; per-project rules go in `AGENTS.override.md` (gitignored, loaded after `AGENTS.md`).
- `.workflow/state/budget.yml`: the session budget. Adjust it for this project.
- Skills, hooks and subagents that match the project profile, in the `.claude` directory, in its skills, hooks and agents subfolders.

Init copies hooks into the hooks subfolder but does not register them in Claude Code's settings. A hook is active only after you add it to Claude Code's project settings yourself, so do not assume one is enforcing a rule unless you have seen it wired.

## Specs

Write requirements as EARS specs in a specs folder that you create, and trace each change to one.
