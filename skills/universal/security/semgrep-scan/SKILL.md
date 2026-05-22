---
name: semgrep-scan
description: Run Semgrep static analysis to detect insecure code patterns - SQL injection, XSS, path traversal, weak crypto, broken auth, OWASP Top 10 issues. Use on every file change touching security-sensitive code and as part of the tiered security gate. Complements gitleaks (which catches secrets) by catching insecure logic.
---

# Semgrep Scan

> Static analysis with the OWASP Top 10 rulesets and language-specific
> security packs.

**Tradeoff:** ~10-30s scan time on a medium repo. Worth it: catches insecure
patterns gitleaks can't see (logic, not secrets).

---

## When to invoke

- Tier 1: on file change for security-sensitive code paths
- Tier 2: every PR via CI
- Tier 3: pre-release with `--config=p/owasp-top-ten --config=p/r2c-security-audit`

---

## Install

```bash
pip install semgrep
# or
brew install semgrep
```

---

## Configure

`.semgrep.yml`:
```yaml
rules:
  - p/owasp-top-ten
  - p/r2c-security-audit
  - p/javascript
  - p/typescript
  - p/python
  - p/sql-injection
  - p/jwt
  - p/insecure-transport
  - p/secrets
```

Custom rule example (catch logging of PII):
```yaml
rules:
  - id: log-pii
    pattern-either:
      - pattern: console.log($USER.email)
      - pattern: logger.info($USER.email)
    message: Logging email addresses leaks PII. Use a redacted identifier.
    severity: ERROR
    languages: [javascript, typescript]
```

---

## On finding

ERROR severity: hard-fail the commit/PR.
WARNING severity: surface in PR comment, block on accumulated count.
INFO: log only.

---

## Integration with claim-validator

A "security scan" claim must include:
- `proof.test_command: semgrep --config=p/owasp-top-ten ./src`
- `proof.test_exit_code: 0`
- Findings count by severity

---

**This skill is working when:** new insecure patterns are caught before merge,
not in production.
