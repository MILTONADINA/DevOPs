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

## REQ-4 — Test code is in scope

THE REPOSITORY SHALL carry a root `.semgrepignore` whose only exclusions are:
- the entries of Semgrep's built-in default list other than its "Common test paths" block: version-control folders and large or generated paths;
- files named individually, each with a comment giving the reason.

Without that file, Semgrep's default list also skips every `test/` and `tests/`
directory, which on 2026-09-25 was 251 of 986 files. A reviewer (Workflow
`wf_6e861584-e0b`) found that the job then reported a whole-repository pass
over a scan that excluded them. A file that must hold credential-shaped strings
on purpose, such as the gitleaks negative fixture
`tests/fixtures/security/poisoned-mcp-config.json`, is excluded by exact path.
A false positive in code is annotated with `nosemgrep: <rule id>` and a reason
on the line above it, never by excluding a directory.

## Acceptance criteria

### AC-1 (REQ-1..3)
**Given** the job's step script in the pinned image **When** it runs on the
repository, on a directory holding planted findings (`subprocess` with
`shell=True`, an MD5 hash), and on an empty directory **Then** it exits 0, 1 and
1 respectively, and the repository run reports a nonzero count of scanned
files.

### AC-2 (REQ-4)
**Given** the repository **When** the job's scan runs **Then** its scanned
paths include files under both `tests/` and `stratum/test/` (the job fails if either tree is missing), and exclude
`tests/fixtures/security/poisoned-mcp-config.json`. **Given** the
`.semgrepignore` removed **Then** the scanned-file count falls by the number
of test files. Measured locally with Semgrep 1.167.0: 985 files scanned, 250 of
them tests, 0 findings, against 734 files without the ignore file.
