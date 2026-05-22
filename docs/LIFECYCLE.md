# Lifecycle Reference

Seven phases. Current phase recorded in `.workflow/state/lifecycle.txt`.

## Switching phases

```bash
echo "harden" > .workflow/state/lifecycle.txt
```

## Phase quick reference

| Phase | Activities |
|-------|-----------|
| discovery | EARS specs, user journeys, threat surface scan |
| design | C4 + ERD + OpenAPI + threat models + ADRs |
| build | Implement specs, TDD, proof artifacts |
| harden | Tier 3 security, load test, DR drill, runbooks |
| launch | Canary deploy, watch SLOs intensely |
| operate | Run reliably, respond to incidents |
| evolve | Major changes, refactors, migrations |

See `lifecycle/<phase>/PHASE.md` for acceptance gates.
