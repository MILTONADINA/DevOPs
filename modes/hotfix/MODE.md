# Hotfix Mode

## When to activate

- Open production incident (sev-1 or sev-2)
- Fix must ship in < 1 hour

## Rules — MAXIMUM SAFETY, MINIMUM SCOPE

- **Smallest possible diff** — one-line fix preferred
- **Test the regression** — failing test reproduces the bug first
- **Verify in staging** before prod, even under pressure
- **Approvers required** — validator subagent + a human
- **Postmortem within 48h** — not optional
- **No new dependencies**, **no schema changes** unless the bug IS schema-related
- **Production write block still applies** — the user approves each production deploy (constitution/ANTIPATTERNS.md, Antipattern 8)

## Acceptance gates to exit hotfix

- [ ] Fix verified in staging
- [ ] Fix deployed with monitoring
- [ ] Regression test added
- [ ] Incident doc at `docs/incidents/INC-YYYY-MM-DD-NNN.md`
- [ ] Postmortem scheduled
- [ ] Mode reverts to brownfield
