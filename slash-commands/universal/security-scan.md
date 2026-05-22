---
name: security-scan
description: Run the tiered security scan stack appropriate for current lifecycle phase. Tier 1 on file change (gitleaks), Tier 2 per PR (semgrep + dep audits + WCAG), Tier 3 pre-release (full history + DAST + red-team). Emits a security-findings claim.
---

# /security-scan

Invokes the `security` subagent. Tier inferred from the active lifecycle phase
(see `.workflow/state/lifecycle.txt`):

- discovery/design → Tier 1 only
- build → Tier 1 + 2
- harden → Tier 1 + 2 + 3
- launch/operate → Tier 1 + 2 + selective Tier 3

Emit proof artifact at `.workflow/proofs/claim-YYYY-MM-DD-NNN.yml` with scan
results.

Run as: `/security-scan` or `/security-scan --tier=3`
