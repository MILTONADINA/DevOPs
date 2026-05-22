---
name: resume
description: Resume from .workflow/state/baton.md. Reads the baton, addresses blockers first, then continues from next_action. Use at the start of any session when a baton exists.
---

# /resume

1. Read `.workflow/state/baton.md`
2. Read `.workflow/state/blockers.md`. If any open, surface them first.
3. Continue from the `next_action` section in the baton.

Run as: `/resume`
