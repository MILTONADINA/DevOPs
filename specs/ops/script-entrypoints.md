# Repository scripts start the same way through any path

**Status**: approved (owner, 2026-10-18, in chat: "do it all"; issue #293)
**Spec ID**: ops/script-entrypoints
**Owner**: Milton Adina

## Scope

Repository scripts under `scripts/` that run their work only when started directly
(not when imported by a test or another script). This covers how they decide that.
It does not cover what each script does.

## Problem

- Each script compared `process.argv[1]` with its own `import.meta.url` as written.
- Node resolves symlinks in the main module's path, so started through a symlinked
  folder (macOS `/var/folders`, or a checkout reached through a link) the comparison
  was false and the script exited 0 without doing anything.
- `scripts/triage-claims.mjs` built a `file://` URL by string concatenation, which
  also failed on paths with spaces.

## Requirements

### REQ-1 — Started directly means the same real file

A script SHALL treat itself as started directly WHEN the real path of `process.argv[1]`
equals the real path of its own module. It SHALL NOT start its work WHEN
`process.argv[1]` is missing or either real path cannot be resolved. Scripts use the
shared `scripts/lib/is-main.mjs`; a script staged alone outside the repository
(`scripts/dast/proxy.mjs`) keeps a self-contained copy of the same check.

**Enforced by:** test:tests/is-main.test.mjs

### REQ-2 — The shared check is part of the retained DAST runner identity

WHEN a DAST run is retained, `runner-sources.json` SHALL include
`scripts/lib/is-main.mjs`, since it decides whether the runner starts.

**Enforced by:** test:tests/is-main.test.mjs

## Acceptance criteria

- AC-1: Started through a direct path, including one with a space, the check is true.
- AC-2: Started through a symlinked folder, the check is true, and a real script
  (`scripts/triage-claims.mjs`) runs its work.
- AC-3: Imported rather than started, with `argv[1]` missing, or with a path that does
  not exist, the check is false.
- AC-4: `scripts/run-dast.mjs` lists `scripts/lib/is-main.mjs` in the retained runner
  source roster.

## Out of scope

- Scripts that do not guard their entry point.
- Windows symlink behaviour (the symlink tests are skipped there).
