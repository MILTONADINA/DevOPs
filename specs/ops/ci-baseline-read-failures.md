# CI baseline reads must succeed before ratchet checks

**Spec ID:** ops/ci-baseline-read-failures
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** the two existing baseline-read fallbacks in the required `validate`
job of `.github/workflows/ci.yml`, under Decision12's reversible CI-fix route.

## Existing obligations and source defect

`specs/ops/payment-removal.md` REQ-12 / AC-11 requires a lower test floor to
have a matching new declared lowering against the base floor. The renamed
suite's floor must carry over under `specs/ops/one-platform-naming.md` REQ-5 /
AC-5. Masterpiece REQ-M23 and REQ-M8 retain the test-floor and shrinking
spec-status baseline duties. This narrow correction does not approve or
complete the whole masterpiece draft, change those policies or rewrite their
historical requirements and observations.

At the start of this maintenance change, the two selected steps replaced every
failed `git show` with `{}`.
The test-floor checker then has no numeric base keys to compare. The status
checker permits a base without `spec_status` for its historical introduction
case. Required Git input failure can therefore become a passing ratchet.
This source defect does not establish that a real PR lowered a floor or
expanded a baseline through this path.

## REQ-1 — Stop each selected CI step when its base read fails

**Enforced by:** test:tests/ci/baseline-read-failure.test.mjs; job:.github/workflows/ci.yml#validate
WHEN either step below runs, THE STEP SHALL retain its existing PR-only
condition, `shell: bash`, `BASE_REF` environment binding and
`git fetch --no-tags origin "$BASE_REF"` followed by the listed `git show`.
IF the fetch or show exits nonzero, THEN THE STEP SHALL exit nonzero before
invoking any Node checker in that step. It SHALL NOT substitute `{}` or other
invented baseline contents for a failed read, including an absent member at
the fetched base.

| Existing step name | Existing show source | Existing destination |
| --- | --- | --- |
| Test floors only rise (or fall by a declared lowering); added test files assert (masterpiece REQ-M23) | `FETCH_HEAD:governance/test-floors.json` | `$RUNNER_TEMP/base-floors.json` |
| Spec-status baseline only shrinks (quality plan MR-11(A)) | `FETCH_HEAD:governance/traceability-baseline.json` | `$RUNNER_TEMP/base-traceability.json` |

The implementation SHALL remove only the two `|| echo '{}' > ...` fallback
clauses. The existing show stderr redirection and Actions Bash failure mode
remain. No new failure text, exact nonzero code or cleanup/atomic-file guarantee
is required: shell redirection may already have created an empty or partial
destination, but a failed acquisition must not reach its consumer.

## REQ-2 — Preserve successful inputs and existing comparison policy

**Enforced by:** test:tests/ci/baseline-read-failure.test.mjs; test:tests/graph/test-floors.test.mjs; test:tests/graph/spec-status.test.mjs; job:.github/workflows/ci.yml#validate
WHEN a selected fetch and show succeed, THE STEP SHALL pass the actual returned
bytes to its existing checker through the existing command and path:

- `node scripts/check-test-floor.mjs --ratchet "$RUNNER_TEMP/base-floors.json"`;
- `node scripts/lint-spec-status.mjs --ratchet "$RUNNER_TEMP/base-traceability.json"`.

THE CHANGE SHALL preserve both checker implementations, CLI selection, output,
declared-lowering and rename rules, spec-status vocabulary and historical
standalone `{}` bootstrap behavior. An unchanged or raised floor, valid new
lowering/rename and unchanged or shrinking status baseline retain their current
results; unauthorized lowering and a growing status baseline remain refusals.
No current numeric floor, baseline membership or historical record changes as
part of the acquisition fix; ordinary evidence-backed test-floor increases
after a measured suite remain governed by the existing policy.

The floor step's existing added-test `git diff`, process substitution,
`mapfile`, selected test trees and assertion-checker branch SHALL remain
unchanged. This slice does not repair that separate diff-status propagation
defect or claim its failure is now mediated.

## REQ-3 — Keep the Git and delivery boundary finite

**Enforced by:** PROCESS
THE CHANGE SHALL preserve the existing fetch, `FETCH_HEAD` authority, fixed
source paths and workflow/job wiring. It SHALL NOT add a Git helper, captured
PR-base/object-mode policy, network call, input-schema framework or new bootstrap
exception. MR17's separately implemented enforcement-baseline preparation is
outside these two steps and SHALL remain unchanged.

THE DELIVERY SHALL distinguish the owned Git/Node fixture evidence from a real
remote fetch or hosted CI run. It SHALL preserve the existing ratchet tests and
write and witness the new regression tests before the two-clause implementation.
The new tests and this narrow spec SHALL be committed before the fix. Required
checks, exact-head review and independent security review still govern delivery;
passing this correction does not close broader M8/M23 or other roadmap duties.

## Acceptance criteria

### AC-1 — Both failed-read paths produce meaningful RED

**Given** each exact selected workflow step running under Bash `-e -o pipefail`
in an owned fixture, with a successful local fetch but the selected member absent
at the fetched base **When** the real Git show fails **Then** the step exits
nonzero and invokes no Node checker. A separate injected nonzero show failure
has the same oracle for each step. Before the fix, the fallback is expected to
produce `{}` and a false success with a visible checker invocation. Those are
meaningful expected RED cases, not absent-feature or tool-launch failures.

### AC-2 — Failure and success controls preserve the integration

**Given** a failed fetch **Then** each step already exits nonzero without show
or Node invocation; retain that passing control. **Given** successful unchanged
or raised floor bytes, a valid declared lowering/rename, and an unchanged or
shrinking status baseline **Then** the actual copied checker succeeds with the
expected summary and receives the exact shown bytes. Unauthorized lowering and
status-baseline growth still fail through those checkers. The successful empty
added-test result and an ordinary added test retain their assertion-branch
behavior. The existing standalone explicit `{}` bootstrap remains accepted;
this is not permission for CI to fabricate it on a read error.

### AC-3 — Actual step extraction and owned prerequisites

The fixture SHALL parse the current `.github/workflows/ci.yml` with the locked
YAML library and uniquely select the two named Bash steps. It SHALL execute the
extracted shell bytes with `--noprofile --norc -e -o pipefail`, owned CWD,
`RUNNER_TEMP` and `BASE_REF`, and a controlled environment. Bash, Git, Node and
YAML availability, source copying and the exact wrapper routing are prerequisites;
missing tools, fixture exceptions or rejected unexpected argv cannot count as
the deliberate Git-read refusals.

An owned local Git repository/origin supplies the successful fetch, real absent
member and diff cases. A fixed Git wrapper records only the allowed fetch/show/
diff argv and may inject the selected failure; it never contacts a remote
service or inspects operator Git state. An owned Node routing wrapper records
the exact requested checker and delegates to the bound Node executable running
the unchanged copied scripts, without duplicating their comparison logic.
Snapshots show that the selected workflow, checker sources and owned current
baseline contents are unchanged by execution; only named fixture Git metadata,
temporary outputs and observation logs may change. Cleanup removes only owned
fixtures. There is no new registry/npm invocation, model call or credential use.

### AC-4 — Minimal source delta and honest delivery evidence

An inverse source comparison SHALL restore the original CI workflow by adding
back exactly the two removed fallback clauses; no other executable workflow
bytes change in this slice. Existing test-floor and spec-status test assertions
remain intact. Record the mixed expected RED and passing controls, then verify
the focused correction before ordinary full gates and required candidate CI.
Source and fixture outcomes SHALL NOT be reported as a hosted workflow run or
a new comparison-policy guarantee.
