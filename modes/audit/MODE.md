# Audit Mode

## When to activate

- Code review of an external codebase
- Compliance audit (COPPA, GDPR, HIPAA, SOC 2, PCI DSS)
- Security review without authorization to fix
- Architectural assessment

## Rules — READ-ONLY

- All file writes blocked except in `docs/audits/`
- No deploys
- No code changes
- Produces a findings document

## Output

`docs/audits/audit-YYYY-MM-DD.md` with: scope, methodology, findings
(critical/high/medium/low/informational), remediation, sign-off.
