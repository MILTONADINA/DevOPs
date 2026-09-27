# Testing

How this repository is tested: the test layers, the CI job that runs each,
the floors that stop a suite from shrinking unnoticed, and what to do with
a flaky test. CONTRIBUTING.md has the rules for pull requests.

## Test layers

| Layer | Command | What it covers | Runs in CI |
|---|---|---|---|
| Root suite | `npm test` | `node --test` over the files listed in the root `package.json` `test` script: the analyzer entry point, test hermeticity, the reproducibility check, local setup, and the graph pipeline (dashboard, resilience, test floors) and Jev tests | `validate` (Node 22); `node-compat` (Node 24 and 26) |
| Stratum unit and component tests | `cd stratum && npm test` | vitest over `stratum/test/` | `stratum-test` (Node 22); `node-compat` |
| Stratum typecheck | `cd stratum && npm run typecheck` | `tsc --noEmit` over `src/`, `scripts/` and `evals/` (test files are not typechecked yet) | `stratum-test`; `node-compat` |
| Stratum lint | `cd stratum && npm run lint` | ESLint and Prettier over `src/` | not yet (quality plan QW-1) |
| Cold setup smoke | `npm run setup` | Starts the local database stack and smoke-tests the proxy from a clean checkout | `setup-linux` (under 300 s) |
| SQL integration tests | `stratum/test/integration/*.sql` | Database behavior against the local stack | `setup-linux` |
| Local database checks | `cd stratum && npm run db:verify-*` | End-to-end checks of memory, audit, recovery and project scoping against the local stack | not yet; run them locally when you change those paths |
| Evals | `cd stratum && npm run test:eval` | The pruner's golden-query tiers | not in CI; required locally when `stratum/src/pruner/` changes (PR template) |

Run `npm ci` at the root before the root suite: its reproducibility-check
tests spawn `tsx` from the root lockfile. On Node 22 and later, the versions
this repository supports, `node --test <directory>` does not search the
directory: Node treats it as a module path and the run fails with
MODULE_NOT_FOUND. Pass files or globs, as the root `test` script does.

## Rules for new and changed tests

- **Hermetic.** A test under `tests/` or matching `*.test.*` must not spawn
  `git`, `brew`, `xcodebuild`, `xcrun`, `npm` or `npx` to learn something it
  can derive in-process (`specs/graph/R-resilience.md`). `tests/hermeticity.test.mjs`
  enforces this. Derive the repo root from `import.meta.dirname`.
- **No network and no real credentials.** Tests stub `fetch` and point any
  dotenv loading at a path that does not exist. A test must never read
  `.env` or reach a hosted service.
- **Red first.** A test that proves a fix must fail on the code before the
  fix. A test that deliberately passes on the old code is a regression guard:
  its title ends with "(regression guard)" and its leading comment names the
  mutation that makes it fail. This convention starts on 2026-09-26; older
  guards are relabelled as their files are next changed.
- **It asserts.** CI rejects an added test file that makes no assertion
  (`scripts/check-assertions.mjs`).

## Test floors

`governance/test-floors.json` sets the minimum number of passing tests for
each suite (`root` and `stratum`). CI parses each suite's output with
`scripts/check-test-floor.mjs` and fails when:

- any test fails;
- the passed count is below the floor;
- no count can be found in the output, so an emptied suite never reads as a
  pass.

On pull requests CI also runs the ratchet: a floor lower than `main`'s
fails, unless the change adds a one-time `lowerings` entry in
`governance/test-floors.json` (suite, from, to, reason and decision). The
ratchet prints each accepted lowering as `LOWERED`, and an entry can be
used only once. The payment-removal cycles, which delete payment tests,
will use it.
When a change adds tests, raise the floor in the same PR to the new passed
count, and say in the file's `_comment` where the number came from.

## Flaky tests

A test that passes and fails on the same code is a defect. Never re-run CI
until it is green and merge.

1. Open an issue with the failing output and the run link.
2. Fix it in the same PR if you can.
3. Otherwise quarantine it: skip it (`test(name, { skip: 'reason' }, ...)`
   in node:test, `it.skip` in vitest) with a comment that links the issue and
   gives an expiry date no more than 14 days away. List the quarantine in the
   PR description.
4. By the expiry date, fix the test or delete it in a PR that says why.

Floors count passed tests, so a quarantine lowers the count. If that takes a
suite below its floor, CI fails and the ratchet refuses a lower floor. Fix the
test instead, or add tests that cover the same behavior.
