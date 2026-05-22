# Runbook — <Service or Incident Type>

**Last updated**: YYYY-MM-DD
**On-call team**: <team>
**SLO doc**: <link>

---

## Quick reference

| Need | Where to look |
|------|---------------|
| Dashboards | <link> |
| Logs | <query / link> |
| Recent deploys | <link> |
| Recent changes | `git log --since="2 days ago" --all` |
| Status page | <link> |
| Postmortem template | `templates/postmortem/POSTMORTEM_TEMPLATE.md` |

---

## When this fires

- Alert: <name>
- Channel: <where the alert appears>
- Symptom: <user-visible behavior>

## Diagnosis steps

1. **Check dashboard**: <link>. Look at error rate, latency, throughput over
   the last 30 min and 24 h.
2. **Check recent deploys**: did anything ship in the last 60 min?
3. **Check upstream dependencies**: <list with status page links>
4. **Search logs**: <example query>
5. **Check resource utilization**: CPU, memory, DB connections

## Common scenarios

### Scenario A: <description>
- Diagnosis: <how to identify>
- Resolution: <steps>
- Time to resolve: ~ <minutes>

### Scenario B: <description>
- Diagnosis: ...
- Resolution: ...

## Escalation

- L1 (on-call): try the scenarios above
- L2 (service owner): <name / contact>
- L3 (architect / VP): only for sev-1 with customer impact

## After resolution

1. Write a brief incident note in `docs/incidents/INC-YYYY-MM-DD-NNN.md`
2. If sev-1: schedule postmortem within 48 hours
3. Update this runbook if anything was learned

## Test the runbook quarterly

This runbook is verified by running scenario drills quarterly. Last drill:
YYYY-MM-DD.
