# SLO — <Service Name>

**Owner**: <team>
**Last reviewed**: YYYY-MM-DD
**Status**: draft | active | retired

---

## Service

<short description of what this service does and who uses it>

## User journeys

What does the user actually care about? List the critical paths.

1. <e.g., authenticate>
2. <e.g., search>
3. <e.g., checkout>

## SLIs (Service Level Indicators)

For each user journey, define what "good" looks like:

### SLI-1: Authentication availability
- Metric: (# successful 200 responses on /auth/login) / (total /auth/login requests)
- Measurement window: 5-minute rolling
- Source: <where this metric comes from>

### SLI-2: Authentication latency
- Metric: p95 latency on /auth/login
- Measurement window: 5-minute rolling
- Source: <where this metric comes from>

## SLOs (Service Level Objectives)

| SLI | SLO | Window | Rationale |
|-----|-----|--------|-----------|
| Auth availability | 99.9% | 30-day rolling | Customer SLA promises 99.9% |
| Auth latency p95 | < 200ms | 30-day rolling | User research shows > 200ms causes drop-off |

## Error budget

- 99.9% over 30 days = 43.2 minutes of allowed downtime per month
- When > 50% of budget consumed: pause non-essential deploys
- When > 100% consumed: stop all non-essential deploys; incident review

## Alerts

| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| Auth-down | Availability < 99% over 5 min | sev-1 | <link> |
| Auth-slow | p95 latency > 500ms over 5 min | sev-2 | <link> |

## Dashboard

<link>

## Review cadence

- Weekly: error budget status
- Quarterly: SLO targets vs. reality
- Annually: full SLO refresh
