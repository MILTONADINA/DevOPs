# Repository hygiene checks

**Status**: implemented (2026-09-28, quality plan QW-9, a direct PR under decision 12)
**Spec ID**: ops/repo-hygiene

Some defects cannot be seen in a pull request's diff. A mode bit that `core.fileMode=false` hides, a version that drifts in a file nobody edited, a screenshot added beside the code, and a new test file that a hand-kept list never runs are four of them. The quality plan found each one on `main` (findings RS-14, RS-12, RS-07 and EP-17). `scripts/check-repo-hygiene.mjs` checks them on every CI run, in the `validate` job.

## REQ-1 — Scripts with a shebang are executable

IF a tracked regular file starts with `#!` and git records its mode as `100644`, THEN the check SHALL fail and name the file.

- **AC-1.1** A `100644` file that starts with `#!` is reported, including a path with a space. A `100755` file and a file without a shebang are not. **Verified by:** `tests/repo-hygiene.test.mjs`.

## REQ-2 — One version

IF the `version` in `.claude-plugin/plugin.json`, or the `**Current version**` line of `governance/VERSION.md`, differs from `package.json`'s `version`, THEN the check SHALL fail and name the file. A missing `**Current version**` line SHALL fail.

- **AC-2.1** Each mismatch is reported on its own, and so is a missing line. **Verified by:** `tests/repo-hygiene.test.mjs`.

## REQ-3 — No committed renders

IF a tracked file ends in `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.html` (in any case) and is not on the check's allowlist, THEN the check SHALL fail and name the file. The allowlist holds the pages that are product source: `runtime/landing.html`, `runtime/src/dashboard/index.html` and `scripts/graph-dashboard/index.html`. Adding to it is a reviewed change to the script.

- **AC-3.1** Allowlisted pages pass. A PDF, an upper-case `.PNG`, an HTML page, a WebP and a JPEG outside the list are reported. **Verified by:** `tests/repo-hygiene.test.mjs`.

## REQ-4 — Every root test file runs

The root `npm test` script SHALL be `node --test "tests/**/*.test.mjs"`, so a new test file under `tests/` runs without anyone editing a list. IF a tracked file under `tests/fixtures/` is named `*.test.mjs`, THEN the check SHALL fail, because the glob would run a fixture as a test.

- **AC-4.1** Any other test script is reported, and so is a fixture named like a test. **Verified by:** `tests/repo-hygiene.test.mjs`.

## Out of scope

- Other version strings: `runtime/package.json` versions the runtime separately, and the release history in `CHANGELOG.md` is history.
- The contents of allowlisted pages.
- Test files outside `tests/`: the runtime runs its own vitest suite.
