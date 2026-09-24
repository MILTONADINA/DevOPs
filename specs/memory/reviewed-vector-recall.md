# Reviewed decisions in project vector recall

**Scope:** `plan.md` §4 long-horizon memory and `specs/memory/reviewed-decision-supersession.md`. The live SessionStart bridge uses promoted vector hits after a bounded recent-fact read. A reviewed successor can be outside that recent window, so candidate-set filtering alone cannot keep an old decision out of vector results. This change does not alter request forwarding or pruning.

## REQ-1 — Filter before the vector limit

WHEN project-scoped vector recall ranks fact vectors, THE DATABASE SHALL exclude an active TechDecision whose exact organization/project has an active, later, reviewed successor linked by `supersedes_id`. It SHALL apply this exclusion before `match_count` limits the vector hits, allowing the next eligible hit to fill the result. A suppressed successor SHALL NOT hide the older active decision. Other active fact types SHALL remain eligible.

## REQ-2 — Preserve trust boundary

WHEN the vector RPC runs, IT SHALL retain exact organization/project filtering and service-role-only execution. Anonymous and authenticated roles SHALL remain unable to execute it. The SessionStart bridge and pruner defaults SHALL remain unchanged.

## Acceptance

- A rolled-back local SQL fixture first fails against the existing RPC, then passes after migration, proving reviewed exclusion before limit and recovery when the successor is suppressed.
- The existing exact-project vector and SessionStart checks, TypeScript checks, and PR gates pass.
