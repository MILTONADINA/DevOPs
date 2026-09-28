# Product test suites in CI

**Status**: implemented (REQ-1 and REQ-2 in PR #174, 2026-09-25; REQ-3 on 2026-09-28, quality plan QW-1)
**Amended**: 2026-09-28: REQ-3 adds the runtime lint gate. The runtime moved from `stratum/` to `runtime/` on 2026-09-27 (`specs/ops/one-platform-naming.md` REQ-5); REQ-1 and REQ-2 keep the path they were written with.

**Scope:** `SHIP_BLOCKERS.md` 1.3(c): "add both to CI so this can't silently
regress again". Until this spec, CI ran the DevOps-core suite (`validate`) and
a timed cold setup (`setup-linux`), but never Stratum's unit suite, its
typecheck, or its SQL integration tests. On 2026-09-25 a proof-corpus repair
found four regressions that had sat on `main` for a day (PR #173).

## REQ-1 — Stratum unit suite and typecheck on every PR

WHEN CI runs for a pull request or a push, THE PIPELINE SHALL install
Stratum's locked dependencies from a clean checkout (`npm ci` in `stratum/`),
run `npm run typecheck`, and run `npm test`. Any failure SHALL fail the job.
The job SHALL NOT provide a real provider key, a database, or a local model
server; tests that need them are integration tests (REQ-2) or stay local.

## REQ-2 — SQL integration tests against the disposable local stack

WHEN the `setup-linux` job has brought up the local Compose stack with every
migration applied, THE PIPELINE SHALL run every
`stratum/test/integration/*.sql` file against that database with
`ON_ERROR_STOP`, and SHALL fail on the first failing file. IF the glob matches
no file, THEN the step SHALL fail rather than pass vacuously. Each SQL test
SHALL keep its fixtures inside its own transaction and roll them back.

## REQ-3 — Runtime lint gate on every PR

WHEN CI runs for a pull request or a push, THE PIPELINE SHALL run `npm run
lint` in `runtime/` after the locked install, in the required `runtime-test`
job. The lint script SHALL fail on any ESLint error or warning
(`--max-warnings 0`) and on any file under `src/` that Prettier would
reformat. Any failure SHALL fail the job. `evals/` and `scripts/` are not in
the gate yet.

- **AC-3.1** `runtime/package.json`'s `lint` script is `eslint src --ext .ts
  --max-warnings 0 && prettier --check src`, and the `runtime-test` job runs
  it after `npm ci`. **Verified by:** `tests/ci-product-suites.test.mjs`.
- **AC-3.2** On the commit before this requirement, `npm run lint` in the
  runtime failed on four unformatted files; on the commit that adds it, it
  exits 0. **Verified by:** the pull request's `runtime-test` job and its
  description.

## Out of scope

The `db:verify-*` Node integration scripts need a real or local model
server, provider keys, or a browser; they stay local until each can run
hermetically. Claim validation in CI is PB-60.

## Acceptance criteria

### AC-1 (REQ-1)
**Given** a PR **When** CI runs **Then** a `stratum-test` job shows `npm ci`,
typecheck and the vitest summary, and a deliberately failing Stratum test
makes that job fail.

### AC-2 (REQ-2)
**Given** a PR **When** `setup-linux` runs **Then** its log lists each SQL
file it ran and the count, and a SQL test that raises makes the job fail.
