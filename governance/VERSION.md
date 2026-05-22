# DevOPs Version Manifest

**Current version**: 0.1.0
**Phase**: 1 of 6 (foundation)
**Released**: 2026-05-22

## Phase status

| Phase | Status | Estimated complete |
|-------|--------|-------------------|
| 1 — Foundation | in-progress | this PR |
| 2 — Security depth | planned | +6 weeks |
| 3 — Memory & observability | planned | +10 weeks |
| 4 — Design phase skills | planned | +14 weeks |
| 5 — SRE & operate | planned | +18 weeks |
| 6 — Self-improvement loop | planned | +24 weeks |

## Per-project version pinning

Projects may pin to a specific DevOPs version by writing:

```yaml
# .workflow/devops-version.yml
devops_version: 0.1.0
```

Workflow updates do not auto-apply mid-project.
