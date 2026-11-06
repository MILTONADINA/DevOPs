# CI Semgrep scan that cannot pass vacuously

**Scope:** the `semgrep` job in `.github/workflows/security-scan.yml` (the tier-2
static scan). Found 2026-09-25 by the masterpiece-standard gap analysis and
confirmed in the CI log of run 36181159732: the deprecated
`returntocorp/semgrep-action` bundled a Semgrep that raised
`ValueError: invalid rule severity value: MEDIUM` on the current registry packs,
scanned nothing, and still reported success, so every PR's `semgrep` check was
green without a scan.

## REQ-1 — A pinned, current scanner

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/assert-scan.test.mjs
THE PIPELINE SHALL run Semgrep from the official `semgrep/semgrep` container
image pinned by digest, with the rules from `semgrep/semgrep-rules` at a pinned commit
(covering the former owasp-top-ten, r2c-security-audit and secrets registry packs),
downloaded and sha256-verified per REQ-6, metrics off.

## REQ-2 — Fail on findings and on errors

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/assert-scan.test.mjs
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

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/assert-scan.test.mjs
IF Semgrep scanned no files, THEN THE JOB SHALL fail with a message that it
refuses to report a pass.

## REQ-4 — Test code is in scope

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/assert-scan.test.mjs
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

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/assert-scan.test.mjs
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
step and check the resulting report on the host. Its scanner status, rule
set, metrics opt-out and test-tree scope SHALL be preserved. The scanner
container SHALL mount the checkout read-only and only a fresh report directory
writable, with Git trust scoped to the checkout mount. It SHALL NOT mount an
operator home or Docker socket. No host-global Git configuration or user home
setting SHALL be changed. The report basename remains `semgrep.json`; moving
its output outside the checkout SHALL NOT alter the scanned source target.

## REQ-6 — Offline scan against digest-pinned rules

**Enforced by:** job:.github/workflows/security-scan.yml#semgrep; test:tests/ci/semgrep-offline.test.mjs
WHILE the Semgrep job scans, THE SYSTEM SHALL run the pinned image with `--network none`
against rule files downloaded in an earlier step and verified against the sha256 digests in
`governance/semgrep-rules.sha256.json`, with no `p/` registry configuration, and SHALL fail
the job when a rule file's digest differs from its pin, when a pin has no valid digest, when a
pinned file is absent or when an unpinned file is present. The files SHALL be fetched with ONE
request for the commit tarball at
`codeload.github.com/semgrep/semgrep-rules/tar.gz/<commit>` (not one request per file), where
`<commit>` is a full lowercase 40-hex SHA recorded in the pins file; a branch, tag or short SHA
SHALL be refused, and so SHALL a rule path that is absolute, contains `.` or `..` segments, a
backslash or a character outside `A-Za-z0-9._-`, or does not end in `.yaml` or `.yml`. Only the
pinned paths SHALL be extracted, and the run SHALL fail, writing no file, on a corrupt or
truncated archive and on any tar entry whose path is absolute, contains a `.`, `..`, empty or
backslash segment or lies outside the archive's single top-level directory, or that is a symlink,
hardlink, device or other non-file entry. An HTTP 429 or 5xx answer SHALL be retried with
exponential backoff and any other HTTP error SHALL fail. A download or redirect that is not
https on `codeload.github.com` without credentials SHALL be refused, and that host SHALL be in
`.workflow/network-allowlist.txt`. Rule files SHALL NOT be
committed (Semgrep Rules License). Pulling the image and downloading the rules stay online.
The registry packs on semgrep.dev SHALL NOT be used: they are regenerated upstream, so a digest of
them drifts without any change here.

## REQ-7 — Digest refresh by a person

**Enforced by:** test:tests/ci/semgrep-offline.test.mjs
THE REPOSITORY SHALL provide `node scripts/semgrep-rules.mjs refresh`, run by a person, which
downloads the commit tarball over https and rewrites the digest of each pinned file, and with a
COMMIT argument (a full 40-hex SHA) moves the pin to that commit; CI SHALL NOT run it. It SHALL
fail, leaving the pins file unchanged, when a pinned file is absent at that commit. WHEN the pin
moves, THE REPOSITORY SHALL document in `docs/SECURITY.md` how to reconcile the file list (files
removed, renamed or added upstream) before running refresh.

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
scope remain unchanged; the rule set is the pinned semgrep-rules files of REQ-6.

### AC-5 (REQ-6)
**Given** the semgrep job **Then** it contains `--network none` and `--config /rules/` (the whole
directory) and no `p/` registry reference. The committed pins name a 40-hex commit of
`semgrep/semgrep-rules` and at least 600 pinned files, with `generic/secrets/`, `javascript/`,
`typescript/` and `python/` among them.

### AC-6 (REQ-6, REQ-7)
**Given** synthetic rule files and pins **Then** a matching digest passes; a mismatch, a missing or
malformed digest, an absent pinned file, an unpinned file (also in a subdirectory), a
duplicate or path-escaping rule path and a source commit that is not a full lowercase 40-hex SHA
each fail; fetch makes exactly one request, for the commit tarball, and extracts only pinned files;
it fails closed on a digest mismatch, a pinned file missing from the archive, a 404, a corrupt or
truncated archive, and any traversal, absolute, backslash, link, device or foreign-top-level entry,
and retries a 429; a download redirect that is not https on `codeload.github.com` without
credentials is refused; refresh rewrites the digests from one tarball, fails leaving the pins
untouched when a pinned file is missing at the new commit, and accepts a new commit only in
full-SHA form; the allowlist names `codeload.github.com`; `docs/SECURITY.md` documents the
file-list reconciliation.
