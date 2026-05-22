# Brownfield Mode (DEFAULT)

## When to activate

- Default for any project with existing code
- Other engineers (or agent sessions) will read what you write

## Rules

- **Surgical edits**: every line traces to the active task
- **Match existing style** even if you'd do it differently
- **Mention but don't fix** tech debt unless asked
- **Tests before changes**: TDD for new features; characterization tests for under-tested code

## Acceptance gates to exit

Most work stays in brownfield. Exit only for `refactor`, `migration`, or `hotfix`.
