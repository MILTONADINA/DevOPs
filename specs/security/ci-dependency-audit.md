# CI dependency audit and dependency review

**Scope:** masterpiece REQ-M22 (`specs/graph/M-masterpiece-standard.md`),
roadmap MR-19, CI part. `docs/SECURITY.md` listed dependency audits as a
tier-2 gate, but no workflow ran one.

## Report-gate amendment scope (2026-10-04)

**Amendment status:** draft

The original scope paragraph records this spec's initial motivation. This
amendment corrects the existing inline dependency-audit report gate under
Decision12's CI delivery route. It preserves REQ-1–3 and historical AC-1,
changes REQ-1's pre-ADR-0026 `stratum/` path to `runtime/`, and adds the finite
report and acceptance requirements below. The existing audit job and pinned
PR dependency-review action remain the delivery mechanisms.

This amendment does not approve or complete the whole masterpiece standard,
M22 or MR19. The dated AC-1 dependency counts remain historical observations.

## REQ-1 — Audit both lockfiles on every PR and push

**Enforced by:** job:.github/workflows/security-scan.yml#dependency-audit
THE PIPELINE SHALL run `npm audit --audit-level=high` against the root and
`runtime/` lockfiles in the `dependency-audit` job of
`.github/workflows/security-scan.yml`. The job SHALL fail on any high or
critical advisory, and SHALL print each vulnerable package with its severity.

## REQ-2 — Never pass an empty audit

**Enforced by:** job:.github/workflows/security-scan.yml#dependency-audit
IF an audited lockfile resolves no dependencies, or `npm audit` reports an
error, THEN THE JOB SHALL fail with a message that it refuses to report a pass.

## REQ-3 — Review dependency changes on pull requests

**Enforced by:** job:.github/workflows/security-scan.yml#dependency-audit
WHEN the event is a pull request, THE JOB SHALL run
`actions/dependency-review-action` (pinned by commit SHA) with
`fail-on-severity: high`.

## REQ-4 — Preserve the existing scanner and two-tree aggregation

**Enforced by:** test:tests/ci/dependency-audit.test.mjs; job:.github/workflows/security-scan.yml#dependency-audit
THE JOB SHALL continue to run exactly the existing
`npm audit --audit-level=high --json` invocation once in each of `.` and
`runtime/`, capture each npm status/report and attempt the second tree even when
the first audit/report refuses. The aggregate job SHALL fail if either refuses.
Every nonzero npm status SHALL remain a refusal, independently of report content.
The final aggregate may normalize failure to1 as it does today; it need not echo
the exact npm status as the process exit, but the observed status remains visible.

The implementation remains the workflow's existing shell/Python step. It adds
no scanner, parser package, report CLI, network call, lockfile change or generic
execution/report framework. Existing required contexts, event triggers and
dependency-review action pin/PR condition/high threshold remain unchanged.

## REQ-5 — Require the finite report fields before trusting them

**Enforced by:** test:tests/ci/dependency-audit.test.mjs; job:.github/workflows/security-scan.yml#dependency-audit
WHEN a report is parsed, THE GATE SHALL require a JSON object, with object-valued
`metadata`, `metadata.dependencies`, `metadata.vulnerabilities` and
`vulnerabilities`. An own `error` member SHALL refuse, whatever its value.

`metadata.dependencies.total` SHALL be an exact integer greater than0.
Booleans, null, strings, floats, nonfinite numbers, absent values and negative
integers SHALL NOT establish a positive dependency count. A numeric integer0
SHALL retain the existing explicit empty-audit refusal.

The vulnerability summary SHALL contain `info`, `low`, `moderate`, `high`,
`critical` and `total`, each an exact nonnegative integer excluding booleans.
Its `total` SHALL equal the sum of the five severity counters. A missing,
wrongly typed, negative or inconsistent counter SHALL refuse.

The top-level `vulnerabilities` object SHALL map nonempty package-name strings
to objects, each with a severity equal to one of `info`, `low`, `moderate`,
`high`, `critical`. Missing, unknown or nonstring severities SHALL refuse.

Unknown extra fields SHALL remain permitted and ignored by this finite policy.
The report file SHALL not be rewritten. This is not full npm-schema validation:
no audit-version field, advisory schema, dependency graph, package-name registry
grammar or equality between map cardinality, vulnerability counts and dependency
count is invented. The existing JSON parser's duplicate-member behavior remains;
this slice does not add a custom JSON parser or atomic input-file sandbox.

## REQ-6 — Refuse reported high/critical findings independently of npm status

**Enforced by:** test:tests/ci/dependency-audit.test.mjs; job:.github/workflows/security-scan.yml#dependency-audit
IF either summary `high` or `critical` is positive, or any vulnerability entry
has either severity, THEN THE GATE SHALL refuse even when npm status is0.
Both sources are inspected; neither an empty map nor a zero summary may conceal
a high/critical value reported by the other.

A well-formed nonempty report with only info/low/moderate findings MAY pass when
npm status is0. A well-formed clean nonempty report SHALL pass when npm status is0.
This preserves the existing high threshold, including development dependencies.
It does not change to critical-only auditing or add `--omit=dev`.

## REQ-7 — Useful normal summaries and fixed invalid-report failures

**Enforced by:** test:tests/ci/dependency-audit.test.mjs; job:.github/workflows/security-scan.yml#dependency-audit
THE GATE SHALL validate the required shapes before printing report-derived
values. For a valid report it SHALL retain the existing summary framing:
`npm audit <directory>: exit <status>, <total> dependencies, vulnerabilities ...`.
The summary SHALL project only the six validated counters; extra arbitrary
metadata is not printed. The fixed directory is `.` or `runtime` from the shell
loop, never a report-selected path.

For each high/critical entry, output SHALL retain the `VULNERABLE` prefix,
severity and package name. Package names and any displayed string range SHALL
be JSON-escaped so control characters cannot manufacture log lines. Nonstring
optional range metadata SHALL be omitted, without rejecting an otherwise valid
finite report. No claim of scanner-output redaction or secret detection is added.

Invalid JSON, unreadable report data, an `error` member or failure of REQ-5
SHALL exit nonzero with exactly this fixed stderr message for that tree:
`npm audit <directory>: invalid audit report; refusing to report a pass\n`.
They SHALL NOT dump raw error objects, report paths, source excerpts or Python
tracebacks. Numeric integer total0 SHALL retain:
`npm audit <directory> saw no dependencies: refusing to report a pass\n`.
Only the Python report gate's new diagnostics are scoped here; native npm stderr
and the separately hosted dependency-review action are not redefined or claimed
to be sanitized by this change.

## REQ-8 — Preserve broader policy and describe the measured scope

**Enforced by:** PROCESS
THE DELIVERY SHALL keep M22 `UNENFORCED` and MR19 open for their whole mixed
obligation. It SHALL NOT change `.githooks/pre-commit`, scanner-missing behavior,
setup's preservation of alternate hook authority, generated consumer hooks,
owner-funded review policy, signing, bot branches or historical proof records.

The spec/consumer note SHALL distinguish report parsing/threshold acceptance
from a real registry audit and hosted dependency-review execution. A synthetic
fixture's advisory is not a newly discovered product vulnerability. Dated audit
counts remain historical. No product lockfile needs a deliberately vulnerable
dependency for this parser correction.

## Acceptance criteria

### AC-1 (REQ-1, REQ-2)
**Given** the job's audit script **When** it runs on the repository, on a
project that locks `lodash@4.17.15`, and on a project with no dependencies
**Then** it exits 0 (root 37 and stratum 513 dependencies, 0 advisories on
2026-09-25), 1 (the lodash advisory is printed) and 1 ("refusing to report a
pass") respectively.

### AC-2 — Existing-step meaningful RED

Before implementation, extract the uniquely named audit step from the actual
workflow using the locked YAML library. In owned fixtures, a matching npm stub
supplies high/critical reports with status0 and invalid dependency counts. The
unchanged step is expected to return0 for those defects while the acceptance
oracle requires nonzero. Record those failures and passing preservation controls;
there is no missing-feature or import-failure shortcut for this existing code.

### AC-3 — Finite report and threshold matrix

Cover clean nonempty and lower-only status0 positives; high/critical reported
only in summary and only in entries; numeric zero; null/string/negative/bool/float
dependency totals; absent/malformed structural fields; absent/negative/bool/float
counter values and inconsistent summary total; unknown entry severity; JSON
parse/error-member failures; and a valid report with nonzero npm status.
Extra unused fields remain accepted. No map-cardinality relation is asserted.
Grouped variants may share one setup but must preserve their distinct oracles.

### AC-4 — Both trees and privacy

Exercise a refusing root with passing runtime and a passing root with refusing
runtime. In each case require the exact two npm invocations/CWDs and aggregate
failure. Both valid reports pass. The owned stub rejects unexpected argv/CWD,
never delegates to real npm and records no credentials. Invalid inputs with
private sentinels cannot appear in gate diagnostics or tracebacks. A valid
finding's control characters are escaped in its one-line output. Native output
from a real scanner is not claimed by these stubbed controls.

### AC-5 — Preservation and delivery

Fixture prerequisites establish available Bash/Python, exact workflow extraction
and routing before deliberate bad reports. Use owned working trees/report paths;
snapshot the workflow and both fixture lockfiles to show the tests do not edit
source or dependency policy. Preserve the pinned PR-only dependency-review
action and high threshold through source assertions, without presenting those
assertions as an execution of that action.

Witness meaningful RED and commit spec/tests before the narrow parser fix.
After focused corrected evidence, required candidate CI supplies a current real
normal-PR audit/review observation. Required checks, exact-head approval and
independent security review still govern delivery. Do not run a second registry
audit solely to repeat an already passing required job.

## Implementation and review limits

The existing shell remains the integration entry; tests run its exact extracted
bytes, not a copied implementation. Shape validation and failure formatting stay
inside the current Python block. Do not expand this into report authenticity,
Git provenance, a generic npm JSON validator, a dependency updater or universal
local secret enforcement.
