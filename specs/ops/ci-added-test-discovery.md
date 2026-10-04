# Added-test discovery must succeed before assertion checking

**Spec ID:** ops/ci-added-test-discovery
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** the existing added-test discovery command in `.github/workflows/ci.yml`.

## Existing obligation and bounded continuation

Masterpiece REQ-M23 / AC-M23.1 requires an added test with no assertions to fail
the assertion check. At the start of this maintenance change, the `validate`
job obtained the file list through
`mapfile -t added < <(git diff ...)`; failure of that subprocess does not become
the status of `mapfile`. An empty failed discovery can report no added tests,
and a failed discovery with partial valid output can check only that partial
list and pass. These are source-derived failure paths, not an observed bypass
by an actual PR.

This is a separate approved Decision12 CI maintenance slice after the accepted
baseline-read fix. That earlier contract deliberately leaves this command
unchanged; its requirements, evidence and two-clause implementation remain
intact. This later slice addresses only the excluded discovery failure and
does not approve or complete the wider masterpiece draft. The temp-file choice
was accepted during preparation; the approval prerequisite in REQ-3 is satisfied.

## REQ-1 — A failed diff cannot become a successful discovery

**Enforced by:** test:tests/ci/added-test-discovery.test.mjs; job:.github/workflows/ci.yml#validate
WHEN the PR step `Test floors only rise (or fall by a declared lowering); added
test files assert (masterpiece REQ-M23)` reaches added-test discovery, THE STEP
SHALL require successful completion of the existing command:

```bash
git diff --name-only --diff-filter=A FETCH_HEAD HEAD -- ':(glob)tests/**/*.test.mjs' ':(glob)runtime/test/**/*.test.ts'
```

IF that diff exits nonzero, including after emitting some filenames, THEN THE
STEP SHALL exit nonzero before invoking `scripts/check-assertions.mjs` or
printing `check-assertions: no test files added`. The preceding successful floor
ratchet remains permitted; the assertion checker is the consumer being gated.
No exact nonzero exit code or new diagnostic text is required.

The proposed minimal implementation SHALL redirect this standalone diff command
to `"$RUNNER_TEMP/added-tests.txt"`, then run
`mapfile -t added < "$RUNNER_TEMP/added-tests.txt"` under the step's existing
Bash `-e -o pipefail` behavior. It SHALL NOT keep the unchecked process
substitution or use partial data after a failed command. Empty or partial temp
files may remain after refusal; this is not an atomic-file or cleanup guarantee.

## REQ-2 — Preserve the successful file selection and checker

**Enforced by:** test:tests/ci/added-test-discovery.test.mjs; test:tests/graph/test-floors.test.mjs; job:.github/workflows/ci.yml#validate
WHEN diff succeeds, THE STEP SHALL preserve the exact current argument vector,
two pathspecs, `FETCH_HEAD HEAD` comparison, line-based `mapfile -t` behavior,
quoted `"${added[@]}"` arguments and existing assertion/no-added branch.
A successful empty result SHALL still print the existing no-added message and
succeed. Selected assertion-bearing tests SHALL still pass, and a selected
assertion-free test SHALL still fail through the unchanged checker.

THE CHANGE SHALL preserve `scripts/check-assertions.mjs`, fetch/base preparation,
floor ratchet, PR condition, shell, workflow/job wiring and unrelated commands.
It SHALL NOT add a NUL-delimited protocol, filename normalization/filtering,
new test globs, Git helper, network call or replacement assertion parser. Existing
Git quoting and newline-containing filename limitations remain; this slice
does not establish complete handling of every legal Git pathname.

## REQ-3 — Test the real step and retain the evidence boundary

**Enforced by:** PROCESS
THE TESTS SHALL extract the exact named Bash step from the current workflow with
the locked YAML library and execute it under `--noprofile --norc -e -o pipefail`
in an owned fixture. A bounded wrapper SHALL allow only the fixed fixture Git
and Node routes, record calls and inject the selected diff failure. Successful
selection uses actual owned local Git; the assertion and floor checkers are
unchanged copied sources. No remote service, operator Git state, credential,
registry/npm invocation or model call is part of this fixture.

THE DELIVERY SHALL witness the new regression failures and commit tests/spec
before implementation, preserve prior assertions and baseline-read evidence,
and pass focused correction before ordinary full gates and required candidate
CI. Fixture results SHALL remain distinct from hosted CI observations. Parent
review must accept the proposed temp-file choice before promotion or execution.

## Acceptance criteria

### AC-1 — Empty and partial failed discoveries

With successful baseline read and floor ratchet, inject a nonzero diff first
with no output and then with one ordinary existing assertion-bearing filename
as partial output. Both cases must exit nonzero without assertion-checker
invocation or the no-added message. The partial path must exist and pass the
unchanged checker when selected successfully, so missing-file refusal cannot
masquerade as this correction. The original process substitution is expected
to return success in these cases; tool/fixture failures do not count as RED.

### AC-2 — Successful and policy-preservation controls

A genuine successful empty Git diff retains the no-added success. Actual added
root and runtime test files reach the checker with their exact selected paths;
ordinary unrelated files remain excluded by the existing globs. Good tests
pass and an assertion-free selected test fails. Existing baseline-read failure,
declared-floor policy and standalone checker tests remain unchanged.

### AC-3 — Prerequisites and minimal source delta

Inspect Bash/Git/Node/YAML availability, local-only origin, wrapper routing and
copied source identities before behavior runs. Preserve workflow/checker/current
baseline bytes, allowing only owned Git metadata, named temporary reports and
observation logs to change; cleanup is limited to those fixtures. An inverse
comparison must restore the predecessor workflow by replacing only the checked
two-line diff/mapfile sequence with its prior one-line process substitution.
No source change to the accepted earlier baseline-read fix is required.
