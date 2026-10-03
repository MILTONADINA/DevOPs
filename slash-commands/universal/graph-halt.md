---
name: graph-halt
description: Blocks recognized consequential Bash commands and new graph sprint launches or resumes until a human runs /graph-resume; ordinary diagnostics remain available.
disable-model-invocation: true
---

# /graph-halt

Creates `.workflow/state/graph-halt`. While it exists,
`hooks/universal/pre-tool/deploy-gate.sh` rejects the recognized consequential
commands in `specs/graph/M-masterpiece-standard.md` REQ-M16 before its
deploy-only return: deployment/publication, Git push/commit/tag and supported
destructive ref/history operations, GitHub release mutations, Supabase database
pushes and `gh pr merge`. An approval marker cannot override the halt. Ordinary
diagnostics such as `git status`, `git -C . status`, `git log/show/rev-parse`,
`ls` and inert `echo` remain available.

The file also fails `scripts/graph-preflight.sh`'s `halt.absent` check, so
`/sprint` refuses a new launch or resume. A cycle already past preflight can
keep running: the halt does not cancel a child, roll back completed work or
prevent arbitrary script/file-tool activity. Use this human control when a
cycle looks wrong, investigate, and have the authorized human clear it through
`/graph-resume` after fixing the fault.

```bash
mkdir -p .workflow/state
echo '{"ts":'"$(date -u +%s)"',"halted_by":"<your identifier>","reason":"<why>"}' \
  > .workflow/state/graph-halt
```

Run as: `/graph-halt <reason>`
