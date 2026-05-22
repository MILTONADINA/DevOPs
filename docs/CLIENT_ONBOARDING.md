# Client Onboarding Checklist

For new clients, complete this checklist before the first agent session.

## 1. Create the project directory

```bash
mkdir ~/clients/<client-name> && cd ~/clients/<client-name>
git init
```

## 2. Run the analyzer

```bash
analyze.sh
init-project.sh
```

## 3. Fill in client profile

```yaml
# .workflow/client/profile.yml
name: <client-name>
data_classes: [PII, financial]   # what kinds of data does this client's app handle?
compliance_scope: [GDPR, PCI DSS]   # which regulations apply?
pentest_authorization: |
  Written authorization from <name> at <client> on <date>.
  Scope: example.com and all subdomains.
  Excludes: production database (read replicas only).
billing_rate_per_hour_usd: 0.00   # if billable
```

## 4. Configure budget

```yaml
# .workflow/state/budget.yml
session_cap_usd: 5.00
hourly_cap_usd: 20.00
daily_cap_usd: 100.00
monthly_cap_usd: 500.00   # adjust to client contract
```

## 5. Wire Stratum (recommended)

```bash
export ANTHROPIC_BASE_URL=http://localhost:4080
export STRATUM_TENANT_ID=<client-name>
```

## 6. Set up path allowlist (if needed)

If the project needs access to paths outside its root (rare, prefer not to):
```bash
# .workflow/client/path-allowlist.txt
# One path per line, absolute or with $HOME expansion. Document rationale.
```

## 7. Initial session

```bash
# Open in your coding agent. The session-start hook prints status.
# First task: write user journeys + EARS specs.
```

## 8. Schedule recurring reviews

- Weekly: cost report (`devops cost-report --client <name>`)
- Quarterly: security re-audit
- Annually: full compliance audit
