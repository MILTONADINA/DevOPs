---
name: checkpoint
description: Write the baton at .workflow/state/baton.md for tool handoff. Aggregates session summary, lists open blockers, captures next_action. Use when approaching session limits, before switching tools, or at natural task boundaries.
---

# /checkpoint

Invokes the `baton-handoff` skill. Specifically:

1. Run `session-summary` skill to aggregate verified claims and blockers
2. Run `write-baton.sh` hook to compose `.workflow/state/baton.md`
3. Print confirmation with session stats

Run as: `/checkpoint`
