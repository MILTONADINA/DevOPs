# DevOPs Version Manifest

**Current version**: 0.3.0
**Phase**: 3 of 6 (memory & observability), in progress
**Released**: 2026-09-23

## Phase status

| Phase | Status | Released / estimated complete |
|-------|--------|-------------------------------|
| 1 — Foundation | shipped (v0.1.0) | 2026-05-22 |
| 2 — Security depth | shipped (v0.2.0) | 2026-05-25 |
| 3 — Memory & observability (Stratum closeout — Option B locked) | in progress (v0.3.0 shipped 2026-09-23) | TBD |
| 4 — Design phase skills | planned | TBD |
| 5 — SRE & operate | planned | TBD |
| 6 — Self-improvement loop | planned | TBD |

See `governance/changelog/PHASE-2-CLOSURE.md` for the Phase 2 sealed-state
reference. Stratum Phase 3 scope is locked to Option B (Stratum Phase 0
+ 1 + 3) per session 7.5 audit decision; see `docs/LAUNCH_READINESS.md`
(on `stratum-merge`, merged to `main` in v0.2.0).

## Per-project version pinning

Projects may pin to a specific DevOPs version by writing:

```yaml
# .workflow/devops-version.yml
devops_version: 0.2.0
```

Workflow updates do not auto-apply mid-project.
