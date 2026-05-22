# Project Analyzer

See `analyzer/README.md` for the active code.

## What it detects

- Languages, package managers, frameworks
- Databases, ORMs, deploy targets, auth providers
- Project state: greenfield / brownfield / hotfix
- Compliance scope: COPPA, HIPAA, PCI DSS (from README + dependencies)
- Risk profile: open vulnerabilities, recent incidents

## What it recommends

For each detection:
- Tier 3 skills to install
- Tier 3 hooks (e.g., schema-migration safety for Prisma projects)
- MCP servers
- Subagent specializations
- Initial mode and lifecycle phase

## Output

- `.workflow/profile.yml` — structured profile
- `.workflow/recommendations.md` — human-readable summary

## Run

```bash
analyze.sh           # detects + writes profile
init-project.sh      # installs the recommended config
```
