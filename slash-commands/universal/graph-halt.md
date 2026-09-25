---
name: graph-halt
description: Kill switch for the graph-engineering pipeline. Immediately blocks all further graph-initiated actions (any deploy-shaped command, any new sprint cycle) until /graph-resume is run.
disable-model-invocation: true
---

# /graph-halt

Creates `.workflow/state/graph-halt`. `hooks/universal/pre-tool/deploy-gate.sh`
checks for this file right after its command pre-filter: while the file exists,
it blocks every command the pre-filter matches (`vercel`, `wrangler`,
`npm publish`, `git push`, `git commit`, `git tag`). Commands the pre-filter does
not match are not blocked (masterpiece roadmap MR-3 moves the halt check first). It also fails
`scripts/graph-preflight.sh`'s `halt.absent` check, so `/sprint` refuses to
launch or resume a cycle (the Workflow's own preflight role repeats the check
before its planner runs). A cycle already past preflight keeps running; only
its deploy/publish commands (vercel, wrangler, npm publish) and git
commit/push/tag are blocked.

This is a real human safety control — use it if a running cycle looks
wrong, before investigating further. It does not roll back anything already
done; it only stops new graph actions.

```bash
mkdir -p .workflow/state
echo '{"ts":'"$(date -u +%s)"',"halted_by":"<your identifier>","reason":"<why>"}' \
  > .workflow/state/graph-halt
```

Run as: `/graph-halt <reason>`
