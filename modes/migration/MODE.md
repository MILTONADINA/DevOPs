# Migration Mode

## When to activate

- Moving from one tech to another with parallel-run capability
- Cutover is gradual with rollback

## Rules

- **Parallel-run by default** with feature flag
- **Compatibility shim** maps new shape to old contract until cutover
- **Cutover with monitoring** — percentage rollout, watch error rate
- **Decommission only after** 14 days at 100% traffic with zero incidents

## Acceptance gates

- [ ] 100% on new code path for 14 days
- [ ] Zero incidents in that window
- [ ] Old code path removed in a separate PR
- [ ] ADR closing the migration
