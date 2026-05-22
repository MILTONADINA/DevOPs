# Postmortem — INC-YYYY-MM-DD-NNN

**Incident**: <short title>
**Severity**: sev-1 | sev-2 | sev-3
**Duration**: HH:MM → HH:MM UTC (X minutes)
**Customer impact**: <e.g., 8% of /api/checkout requests failed>
**Author**: <user>
**Status**: draft | reviewed | published

---

## Summary

<2-3 sentences. What happened, what caused it, how it was resolved.>

## Timeline (UTC)

| Time | Event |
|------|-------|
| 10:14 | Alert fired: api-error-rate > 5% |
| 10:16 | On-call paged |
| 10:21 | First responder online; began diagnosis |
| 10:34 | Identified bad deploy as root cause |
| 10:38 | Rollback initiated |
| 10:42 | Error rate returned to baseline |
| 10:55 | All-clear declared |

## Root cause

<technical explanation. Not "the developer made a mistake" — name the
process / system failure that allowed the mistake to ship.>

## Contributing factors

- ...
- ...

## What went well

- Detection time: <X> min (target: <Y>)
- ...

## What went poorly

- ...

## Action items

| # | Action | Owner | Due | Status |
|---|--------|-------|-----|--------|
| 1 | Add canary deploy to /api/checkout | <user> | YYYY-MM-DD | open |
| 2 | Update runbook for this scenario | <user> | YYYY-MM-DD | open |
| 3 | ... | | | |

## Lessons learned

<honest assessment. What surprised the team? What process needs to change?>

## Blameless statement

This postmortem is blameless. The goal is to learn how the system allowed
this incident, not to assign fault to any individual.
