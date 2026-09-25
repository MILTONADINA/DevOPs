# CI Semgrep scan that cannot pass vacuously

**Scope:** the `semgrep` job in `.github/workflows/security-scan.yml` (the tier-2
static scan). Found 2026-09-25 by the masterpiece-standard gap analysis and
confirmed in the CI log of run 36181159732: the deprecated
`returntocorp/semgrep-action` bundled a Semgrep that raised
`ValueError: invalid rule severity value: MEDIUM` on the current registry packs,
scanned nothing, and still reported success, so every PR's `semgrep` check was
green without a scan.

## REQ-1 — A pinned, current scanner

THE PIPELINE SHALL run Semgrep from the official `semgrep/semgrep` container
image pinned by digest, with the `p/owasp-top-ten`, `p/r2c-security-audit` and
`p/secrets` registry packs, metrics off.

## REQ-2 — Fail on findings and on errors

WHEN Semgrep reports any finding, or any error whose level is not a warning,
THE JOB SHALL fail and SHALL print each finding's severity, rule, path and line.

## REQ-3 — Never pass an empty scan

IF Semgrep scanned no files, THEN THE JOB SHALL fail with a message that it
refuses to report a pass.

## Acceptance criteria

### AC-1 (REQ-1..3)
**Given** the job's step script in the pinned image **When** it runs on the
repository, on a directory holding planted findings (`subprocess` with
`shell=True`, an MD5 hash), and on an empty directory **Then** it exits 0, 1 and
1 respectively, and the repository run reports a nonzero count of scanned
files.
