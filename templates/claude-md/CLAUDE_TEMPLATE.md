# CLAUDE.md

Claude Code adapter for this project. The operating contract is in `AGENTS.md`.

## At session start

1. Read `AGENTS.md`.
2. Read the constitution it points to: {{constitution/PRINCIPLES.md}}, {{constitution/ANTIPATTERNS.md}} and {{constitution/LOOP.md}}.
3. If a recent baton file was written to `.workflow/state`, resume from its Next action section.

## What `devops init` installed here

- `AGENTS.md`: the contract above. Do not edit it; per-project rules for every agent go in `AGENTS.override.md` (gitignored). Codex CLI reads it natively; Claude Code does not load it itself, so read it at session start when it exists.
- `.workflow/state/budget.yml`: the session budget. Adjust it for this project.
- Skills, hooks and subagents that match the project profile, in the `.claude` directory, in its skills, hooks and agents subfolders.

Init copies hooks into the hooks subfolder and registers the safety hooks in Claude Code's project settings (`.claude/settings.json`); `docs/HOOKS.md` in the `@miltonadina/devops` package lists which hooks are wired and which are not. Do not assume a hook that is not wired there is enforcing a rule.

## Specs

Write requirements as EARS specs in a specs folder that you create, and trace each change to one.
