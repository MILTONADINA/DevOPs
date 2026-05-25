# Docs-Only Change Fixture — AC-B1.2

This fixture is intentionally minimal. It represents a "documentation
only" diff that the deepteam job in `.github/workflows/security-scan.yml`
should SKIP per REQ-B1's path filter (no agent-behavior paths changed).

The presence of THIS README is the entire fixture. In a PR scenario, a
diff that touches only this directory (or other `docs/**` paths) would
evaluate the deepteam job's `path-filter` step's else-branch
(`should_run=false`) and skip the substantive DeepTeam invocation —
saving red-team budget on guaranteed-pass outcomes.

Verified end-to-end by claim 066 (REQ-B1 path-filter structural check
emits should_run=false for docs-only diffs).
