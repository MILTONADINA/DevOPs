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

## REQ-4 — Bounded setup infrastructure retries

WHEN local Compose startup reports a public registry rate limit, THE SYSTEM
SHALL attempt startup at most seven times, waiting 2, 4, 8, 16, 32 and 64
seconds between attempts (126 seconds total backoff). It SHALL stop immediately
on success or a non-rate-limit error and preserve the final sanitized error on
exhaustion. Normal local setup behavior SHALL otherwise remain unchanged.

THE `setup-linux` job SHALL keep its required-check name and configure npm
fetch-retries to 5, fetch-retry-mintimeout to 10000 and fetch-retry-maxtimeout
to 60000 before setup. Its npm processes, including nested setup commands,
SHALL inherit `NODE_OPTIONS=--dns-result-order=ipv4first`. These npm settings
SHALL NOT change local setup or other CI jobs.

IF a Compose image is referenced by tag only, THEN THE SYSTEM SHALL NOT switch
its registry. Each local stack image SHALL be referenced as
`registry/name:tag@sha256:<digest>`, so the content is fixed whatever registry
serves it. The three images are pulled from mirror.gcr.io (Google's Docker Hub
cache) with the same index digests public.ecr.aws serves, because ECR Public's
anonymous data quota is exhausted on shared CI runner addresses.

THE `setup-linux` job SHALL restore an `actions/cache` entry (pinned by full
commit SHA) keyed on the SHA-256 of the sorted, exact image references in
`runtime/supabase/docker-compose.local.yml`, before setup. On a hit it SHALL
`docker load` the cached tarball. On a miss it SHALL, before setup, pull those
references one at a time from their own registry, retrying each failed pull at
most four times after waits of 5, 10, 20 and 40 seconds, then `docker save`
exactly those references and save them to the cache. Because the cache is
stored before setup runs, a run whose setup later fails still leaves a hit for
the next run. Changing any image reference changes the key.

"Cold" semantics: the cache holds only registry images. The cold-checkout
checks (no `runtime/node_modules`, no project database volume) and the 300
second assertion on `npm run setup` are unchanged. A cache-hit run measures
setup without image pulls, so it is faster than a cache-miss run; only a
cache-miss run exercises the full cold registry path.

Acceptance: stubbed Docker exercises startup past the old three-attempt limit
and exhaustion without real waits; helper tests cover immediate success and
non-rate-limit errors; workflow tests verify job-scoped npm settings and that the cache restore,
load, save and store steps exist, are SHA-pinned and are keyed on the image
references.

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
