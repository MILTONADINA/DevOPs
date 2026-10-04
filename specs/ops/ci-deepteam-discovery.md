# DeepTeam path discovery must succeed before publishing a scheduling decision

**Spec ID:** ops/ci-deepteam-discovery
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** failed PR path-discovery admission in the existing DeepTeam scheduling step; funded review and the broader masterpiece remain outside this slice.

## Existing obligation and decision precedence

`specs/phase-2/B-deepteam-ci.md` REQ-B1 and AC-B1.1/1.2 describe a changed-path
filter for seven agent-behavior prefixes. REQ-B2 describes the non-PR backstop.
The current `security-scan.yml` implements that selection, but failed PR diff
commands are converted into successful output by `|| echo ''`. An empty error
can publish a docs-only skip; partial error output can publish either decision.
These are source-derived failure paths, not an assertion that an actual PR
bypassed a funded security review.

The older Area B spec remains draft. Its funded-model and required merge-gate
statements do not override the later owner Decision9: DeepTeam and Claude
review skip visibly while unfunded and are not passing evidence. DeepTeam is
not one of the six required contexts. This selected Decision12 maintenance
slice addresses failed scheduling-input admission only. It does not authorize
provider keys, paid calls, new required checks, scanner activation, hooks,
Workflow changes or approval of the larger draft masterpiece.

## REQ-1 — Failed discovery publishes no scheduling decision

**Enforced by:** test:tests/ci/deepteam-discovery.test.mjs; job:.github/workflows/security-scan.yml#deepteam
WHEN `GITHUB_EVENT_NAME` is `pull_request`, THE PATH-FILTER STEP SHALL require
successful completion of its existing command:

```bash
git diff --name-only "${BASE_SHA}" HEAD
```

IF that command exits nonzero, including after emitting partial path output,
THEN THE STEP SHALL exit nonzero before writing either `should_run=true` or
`should_run=false` to `GITHUB_OUTPUT`.

IF discovery fails, THEN THE STEP SHALL emit neither the existing REQ-B1
trigger message nor the existing REQ-B1 docs-only skip message.

No exact nonzero status or new error-message text is required. Existing Git
stderr is permitted; this change does not redact Git diagnostics. The proposed
minimal implementation removes only ` || echo ''` from the existing `CHANGED`
command substitution under its existing `set -euo pipefail` shell behavior.
No new helper, output protocol or source-authority policy is selected.

## REQ-2 — Successful selection and non-PR behavior stay unchanged

**Enforced by:** test:tests/ci/deepteam-discovery.test.mjs
WHEN PR discovery succeeds, THE STEP SHALL preserve the existing exact Git
argument vector and `BASE_SHA` step-environment binding.

THE STEP SHALL preserve the following prefix expression verbatim:

```text
^(skills/|hooks/|subagents/|constitution/|mcp-configs/|analyzer/|governance/owasp-asi-2026/)
```

WHEN successful PR output matches that expression, THE STEP SHALL append
`should_run=true` with a terminal newline to `GITHUB_OUTPUT`.
WHEN successful PR output does not match, including empty output, THE STEP
SHALL append `should_run=false` with a terminal newline to `GITHUB_OUTPUT`.

THE STEP SHALL retain the corresponding existing stdout messages:

```text
REQ-B1 trigger: matched agent-behavior paths in PR diff
REQ-B1 skip: docs-only / dep-bump / refactor PR (AC-B1.2)
```

WHEN the event is not `pull_request`, THE STEP SHALL retain its unconditional
`should_run=true` branch without invoking Git.
THE STEP SHALL retain `REQ-B2 trigger: ${GITHUB_EVENT_NAME} event` as that
branch's existing stdout message.

## REQ-3 — Preserve authority, model policy and unrelated source

**Enforced by:** PROCESS
THE CHANGE SHALL leave every workflow byte outside the single failed-diff
fallback deletion unchanged.

THE CHANGE SHALL preserve the checkout depth, step name/id, event conditions,
runner metadata environment, seven-prefix matcher, permissions, action pins,
job timeout, downstream output consumers, package installation and artifact
policy. Existing successful Git quoting/line-based pathname behavior remains;
this is not a general legal-Git-filename guarantee or immutable-base redesign.

THE CHANGE SHALL preserve `scripts/run-redteam.sh`, the six required contexts
and visible unfunded policy. No fixture invocation of the full workflow,
DeepTeam, pip, provider callback or model is part of this acceptance path.

## REQ-4 — Observe real extracted source before changing it

**Enforced by:** PROCESS
THE ACCEPTANCE TESTS SHALL extract the unique actual `jobs.deepteam` step
with `id: path-filter` and name
`REQ-B1 path filter (agent-behavior PRs only; push-to-main bypasses)` using the
existing locked YAML dependency.

THE FIXTURE SHALL execute only that extracted body under owned Bash with
`--noprofile --norc -e -o pipefail` and a clean explicit environment.
THE FIXTURE SHALL use actual owned Git comparisons for successful controls.
THE FIXTURE SHALL record and restrict Git calls to the exact argument vector.
THE FIXTURE SHALL bound process time/output and remove only its owned tree.

THE DELIVERY SHALL distinguish intended nonzero-discovery regressions from
fixture routing, loader, timeout or tool failures.
THE DELIVERY SHALL retain witnessed mixed RED and commit acceptance/spec bytes
before the one-clause correction.
THE DELIVERY SHALL require focused GREEN, existing regressions, required
candidate CI and Decision12 independent security review/full-head approval.

## Acceptance criteria

### AC-1 — Failed empty, partial and native discoveries

Given a valid owned repository and writable owned GITHUB_OUTPUT file, inject
nonzero diff results with (a) no output, (b) a real nonmatching changed path,
and (c) a real matching changed path. Each must fail before publishing any
scheduling line or REQ-B1 outcome message. The partial paths must also have
successful real-diff controls proving their ordinary decisions. Given a
syntactically ordinary but unavailable base object, actual fixture Git must
also fail without a scheduling decision. Missing tools or broken wrappers are
not acceptance evidence. All four original fallback paths are predicted to
return success and therefore fail these tests before correction.

### AC-2 — Successful and non-PR controls

A genuine empty diff and docs-only/excluded-prefix changes retain false and
the exact skip message. Each of the seven exact selected prefixes has a real
owned positive comparison retaining true and the exact trigger message.
Push and schedule retain true and their event message with no Git invocation.
Existing output appends are preserved. Fixture source content includes an
inert private sentinel that must not enter stdout, stderr or GITHUB_OUTPUT;
no file contents are printed or executed by this filter.

### AC-3 — Fixed wiring and minimal delta

Verify the actual named step, BASE_SHA expression, fixed argv and downstream
output conditions. Source-preservation evidence must reconstruct the entire
predecessor workflow by restoring only the deleted fallback. Existing
required-check policy and red-team wrapper bytes remain identical. No new
registry, scanner, package, hook, provider or Git routing policy is introduced.

### AC-4 — Honest proof boundaries

Preread the actual workflow, owned Git/grep/Bash/Node/YAML prerequisites,
call routing, partial-path preconditions and predicted mixed results before
execution. Preserve logs, output-file bytes and exact source bindings for
RED/GREEN. Hosted CI filter results remain separate from synthetic failures;
either result is scheduling evidence, not a funded DeepTeam scan result.
