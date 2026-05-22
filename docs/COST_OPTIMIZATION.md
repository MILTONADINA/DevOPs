# Cost Optimization

See `cost-controls/` for the active config.

## Documented savings

- 3-tier routing: 50-80% reduction
- Batch API: additional 50% on non-real-time work
- Prompt caching for constitution layer: ~10-20% further

## Tiered model routing

| Tier | Model | Subagents | Use for |
|------|-------|-----------|---------|
| 1 | Haiku 4.5 | researcher, tester | Read-heavy, mechanical |
| 2 | Sonnet 4.6 | coder, reviewer, security | Default workhorse |
| 3 | Opus 4.7 | planner, validator | Architecture, final verification |

## Hard caps

| Cap | Default | Override |
|-----|---------|----------|
| Per-session | $5 | `.workflow/state/budget.yml` |
| Per-hour | $20 | same |
| Per-day | $100 | same |
| Per-month | $1000 | same |

## Dependency updates

Use Renovate over Dependabot. Renovate handles cross-language better and
supports merge-on-green policies.
