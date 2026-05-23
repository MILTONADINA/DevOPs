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

### Renovate setup for consumer projects

DevOPs ships a ready-to-use Renovate configuration template at
[`templates/renovate/renovate.json`](../templates/renovate/renovate.json).
Consumer projects can drop it into their repo root to get sensible defaults
out of the box. The template ships with conservative posture: no auto-merge,
weekly cadence (`before 9am on Monday`) to bound PR noise, with a separate
`vulnerabilityAlerts` lane that bypasses the weekly window for security-only
updates. Patch and minor updates are grouped per-manager into single PRs;
major updates are surfaced individually with `needs-review` labels.

Two-step setup:

1. **Install the Mend Renovate GitHub App** on the consumer repository:
   <https://github.com/apps/renovate>
2. **Copy the template** to the consumer repo's root:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/MILTONADINA/DevOPs/main/templates/renovate/renovate.json \
     -o renovate.json
   ```

The analyzer surfaces this template via `recommended.next_steps` when it
detects a consumer project that lacks `renovate.json` AND `.github/dependabot.yml`
AND carries an upgrade-relevant package manager (npm / pip / cargo / go).
That detection wiring is task H.03 (forthcoming next session — pending the
same `analyzer/scan.ts` vs `recommendation-rules.yml` extension-point
decision surfaced for A.06).

The template explicitly enables `npm`, `pip_requirements`, `pep621`,
`pep723`, `cargo`, and `gomod` managers — the analyzer's full coverage set.
Consumer projects with additional managers can extend `enabledManagers`
without modifying the template's other defaults.

For per-project policy decisions (auto-merge thresholds, lockfile-update
policies, package-specific overrides) consult the upstream Renovate
documentation: <https://docs.renovatebot.com/configuration-options/>.
