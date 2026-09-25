# CI dependency audit and dependency review

**Scope:** masterpiece REQ-M22 (`specs/graph/M-masterpiece-standard.md`),
roadmap MR-19, CI part. `docs/SECURITY.md` listed dependency audits as a
tier-2 gate, but no workflow ran one.

## REQ-1 — Audit both lockfiles on every PR and push

THE PIPELINE SHALL run `npm audit --audit-level=high` against the root and
`stratum/` lockfiles in the `dependency-audit` job of
`.github/workflows/security-scan.yml`. The job SHALL fail on any high or
critical advisory, and SHALL print each vulnerable package with its severity.

## REQ-2 — Never pass an empty audit

IF an audited lockfile resolves no dependencies, or `npm audit` reports an
error, THEN THE JOB SHALL fail with a message that it refuses to report a pass.

## REQ-3 — Review dependency changes on pull requests

WHEN the event is a pull request, THE JOB SHALL run
`actions/dependency-review-action` (pinned by commit SHA) with
`fail-on-severity: high`.

## Acceptance criteria

### AC-1 (REQ-1, REQ-2)
**Given** the job's audit script **When** it runs on the repository, on a
project that locks `lodash@4.17.15`, and on a project with no dependencies
**Then** it exits 0 (root 37 and stratum 513 dependencies, 0 advisories on
2026-09-25), 1 (the lodash advisory is printed) and 1 ("refusing to report a
pass") respectively.
