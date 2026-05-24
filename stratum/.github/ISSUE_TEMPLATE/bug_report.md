---
name: Bug Report
about: Something is broken or behaving unexpectedly
title: "[BUG] "
labels: bug
assignees: ""
---

## Description

<!-- Clear description of what's wrong. -->

## Expected Behavior

<!-- What should happen? -->

## Actual Behavior

<!-- What actually happens? -->

## Steps to Reproduce

1.
2.
3.

## Environment

- CQ version / commit hash:
- Node.js version (`node --version`):
- OS:
- Phase (0 / 1 / 2 / 3 / 4 / 5 / 6):
- ZK-Context enabled: yes / no

## Logs

```
<!-- Paste relevant logs here. Remove any sensitive content (API keys, context content). -->
```

## Pruning Log (if pruning-related)

<!-- If the bug relates to incorrect pruning, include the pruning_log_id from /v1/sessions/:id/stats -->

Pruning log ID:

## Impact

- [ ] Billing records affected (incorrect token counts)
- [ ] AI quality degraded (hallucinations or wrong answers)
- [ ] Security concern — **stop here and email security@startum.com instead**
- [ ] Performance regression
- [ ] Other

## Additional Context

<!-- Anything else that might help. -->
