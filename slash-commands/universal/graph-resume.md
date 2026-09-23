---
name: graph-resume
description: Clears the graph-engineering kill switch set by /graph-halt, allowing sprint cycles and gated deploy/billing actions to proceed again.
disable-model-invocation: true
---

# /graph-resume

Removes `.workflow/state/graph-halt`. Before running this, the human who
called `/graph-halt` (or another authorized person) should confirm whatever
triggered the halt is actually resolved — this command performs no checks
of its own, it only clears the flag.

```bash
rm -f .workflow/state/graph-halt
echo '{"ts":'"$(date -u +%s)"',"event":"graph_resume"}' >> .workflow/state/events.jsonl
```

Run as: `/graph-resume`
