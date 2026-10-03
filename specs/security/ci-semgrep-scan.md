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

WHEN Semgrep reports any finding or any nonempty `errors[]`, including warning
and information levels, THE JOB SHALL fail. It SHALL print each finding's
severity, rule, path and line and each complete error object as JSON-escaped
`SCAN_DIAGNOSTIC` data. Finding summary fields SHALL escape embedded newlines
and control characters and SHALL NOT emit matched-source bodies. A valid
nonzero scanner exit status SHALL be preserved,
even if the report or floor cannot be read or validated.

This strengthens the earlier warning exemption under masterpiece REQ-M14.
PR #230 resolved the three actual PartialParsing errors without changing rules,
ignore scope or test assertions; its required scan at candidate
`b2e9b891fc6ee553ca63058177496de01111b5b7` scanned 1,046 files with zero findings
and zero errors. DeepTeam/Claude's unfunded-skip owner decision is separate.

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

## REQ-5 — Validate the report and enforce its measured minimum

THE PIPELINE SHALL invoke `node scripts/assert-scan.mjs REPORT FLOOR STATUS`
with exactly those three arguments. STATUS SHALL be a decimal integer from
0 through 255. Missing or malformed arguments, inputs or configuration SHALL
fail; an absent scanner result SHALL never default to success. A valid nonzero
third status argument SHALL be preserved even when surplus arguments are refused.

THE REPORT SHALL be a JSON object with `results` and `errors` arrays and a
`paths.scanned` array of unique, nonempty, normalized project-relative POSIX
paths. Absolute paths, backslashes and empty, `.` or `..` path segments SHALL
be refused. The unique scanned count SHALL meet the committed minimum and
include both `tests/` and `runtime/test/` paths.

THE FLOOR file SHALL use a documented finite YAML subset: blank lines,
full-line comments, and exactly one `semgrep: N` entry, with N a positive
safe integer in decimal without leading zeros. Duplicate or unknown keys,
inline comments, strings, mappings, aliases and other syntax SHALL be refused.
The initial minimum SHALL be 1046, from the error-free PR #230 scan above;
this is a measured minimum, not a claim that file counts establish completeness.

THE CI JOB SHALL run the checker with the existing pinned Node22 setup on its
Ubuntu host. It SHALL execute the same pinned Semgrep image once as a Docker
step and check the resulting report on the host. Its scanner status, registry
packs, metrics opt-out and test-tree scope SHALL be preserved. The scanner
container SHALL mount the checkout read-only and only a fresh report directory
writable, with Git trust scoped to the checkout mount. It SHALL NOT mount an
operator home or Docker socket. No host-global Git configuration or user home
setting SHALL be changed. The report basename remains `semgrep.json`; moving
its output outside the checkout SHALL NOT alter the scanned source target.

## Acceptance criteria

### AC-1 (REQ-1..3)
**Given** the host job's step script and pinned scanner container **When** they run on the
repository, on a directory holding planted findings (`subprocess` with
`shell=True`, an MD5 hash), and on an empty directory **Then** it exits 0, 1 and
1 respectively, and the repository run reports a nonzero count of scanned
files.

### AC-2 (REQ-4)
**Given** the repository **When** the job's scan runs **Then** its scanned
paths include files under both `tests/` and `runtime/test/` (the job fails if either tree is missing), and exclude
`tests/fixtures/security/poisoned-mcp-config.json`. **Given** the
`.semgrepignore` removed **Then** the scanned-file count falls by the number
of test files. Measured locally with Semgrep 1.167.0: 985 files scanned, 250 of
them tests, 0 findings, against 734 files without the ignore file.

### AC-3 (REQ-2, REQ-3, REQ-5)

**Given** synthetic scan reports and floor files **When** the checker runs
**Then** clean reports at and above the minimum with both required trees pass;
findings, any error level, missing trees, duplicate or invalid paths and counts
below the floor fail. Every error object is emitted as escaped JSON data.
Malformed/missing report/config/arguments fail. A valid nonzero scanner status
is retained for both valid and broken report/config inputs. Full-line floor
comments are accepted; unsupported configuration forms fail.

### AC-4 (REQ-1..5)

**Given** the reviewed error-free repository and the pinned scanner image
**When** the required CI job runs once **Then** the host checker observes zero
findings/errors, both test trees and a count at or above 1046. The scanner's
status reaches the checker. The supported host Node runtime is explicit; no
Node executable inside the musl scanner image is assumed. Existing ignore
scope and all scanner packs remain unchanged.
