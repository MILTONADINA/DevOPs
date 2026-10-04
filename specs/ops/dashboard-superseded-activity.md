# Dashboard superseded-run activity

**Spec ID:** ops/dashboard-superseded-activity
**Status:** approved (bounded Decision12 read-only-dashboard correction)
**Last updated:** 2026-10-04
**Scope:** exclude selected superseded runs from activity while retaining their observed node evidence.
**Delivery base:** `665f88726769519079c72c9ad379a2fd377d7598` (PR254).

Root selected this finite observer repair under the owner's continuation
instruction and roadmap Decision12. Final contract/test source review and
PR254 delivery preceded promotion. Meaningful RED and the tests/spec commit
precede implementation. This does not approve the whole masterpiece or
authorize a native Workflow launch.

## Obligation and source defect

Masterpiece REQ-M24 requires earlier runs named by `resumedFrom` and
`priorRunIds` to be joined as superseded, never running. REQ-R10 defines those
record fields. The existing `readRunRecords` already provides that association
and gives a record's own runId precedence over another record's earlier-run
references.

`buildRunModel` currently computes `active` from running nodes alone. A joined
superseded run remains active while its agent file is fresh; it can remain
active indefinitely if agent timing is absent. The existing superseded reader
test uses a 30-minute-later clock and therefore exercises only the ordinary
stale timeout. This is a source-derived counterexample, not a claim that a
historical or native run was observed in this condition.

The existing UI already filters live cards and its Active-now badge by `active`
and separately displays the superseded record state. No UI edit is necessary.
Its existing generic Finished badge is not a declaration of successful proof.

This later contract narrowly changes the active/superseded-handling preservation
clause in `specs/ops/dashboard-attempt-identity.md` REQ-3 for this one case.
All of that contract's current-key/current-agent terminal guards and other
preservation requirements remain in force. The original normative texts and
historical acceptance SHALL remain unchanged.

## REQ-1 — Exclude the selected superseded run from activity

**Enforced by:** test:tests/graph-dashboard/superseded-activity.test.mjs
WHEN `buildRunModel` computes a model whose selected `record.status` is exactly
the JavaScript string `superseded`, THE MODEL SHALL return `active:false`.

THE EXCLUSION SHALL apply regardless of fresh, old or absent agent timing.
It SHALL apply to each earlier run joined through either `resumedFrom` or
`priorRunIds`. It SHALL NOT depend on observing a terminal event for that run.

WHEN the selected record is absent or its status is not exactly `superseded`,
THE MODEL SHALL retain the existing running-node activity calculation after
the existing stale transformation. Status spelling SHALL NOT be normalized
or coerced. No new status grammar or malformed-record policy is introduced.

## REQ-2 — Preserve selected-record precedence and evidence

**Enforced by:** test:tests/graph-dashboard/superseded-activity.test.mjs; test:tests/graph-dashboard/reader.test.mjs; test:tests/graph-dashboard/attempt-identity.test.mjs
THE READER SHALL preserve `readRunRecords` admission and join behavior.
A record matched by its own runId SHALL retain precedence over another cycle's
`resumedFrom` or `priorRunIds` reference in either directory-read order.
The new activity exclusion SHALL consult only the record selected by that
existing logic.

THE CHANGE SHALL preserve every model field other than `active` for the
newly excluded case. Labels/nodes SHALL retain the state, result, identity
and timing derived by the existing reader, including its age-based stale
transformation. A fresh or timing-less running node SHALL NOT be rewritten
to done, errored or stale merely to make a superseded run inactive.

THE READER SHALL preserve both stale thresholds, expected/queued nodes,
run/cycle identifiers, observed/kind classification, activity timestamps,
transcript selection, the validator-outcome proxy and `cycleOutcome:null`.
Matching result and failed events SHALL retain done/payload and errored/null
semantics. A matching result with `passed:false` SHALL remain done.
No current-attempt identity guard SHALL be weakened.

## REQ-3 — Keep the observer and consumer boundary narrow

**Enforced by:** test:tests/graph-dashboard/superseded-activity.test.mjs; test:tests/graph-dashboard/reader.test.mjs
THE DASHBOARD SHALL remain read-only and loopback-only. Existing routes,
configuration, Host protection, UI bytes, record writers and discovery policy
SHALL remain unchanged. The change SHALL NOT add an endpoint, production
export, dependency, node-status value, executor or writer.

THE REPAIR SHALL NOT infer proof success, process termination, authentic
chronology, whole-cycle results, readiness or cross-role freshness from a
superseded association. It SHALL NOT apply a new inactive rule to other
record statuses. The README clarification SHALL distinguish selected-record
activity exclusion from the retained journal/node observations.

## REQ-4 — Verify with owned inputs and the five-path delivery scope

**Enforced by:** PROCESS
WHEN new tests exercise the reader, THE FIXTURES SHALL extract the current
real reader declarations using the existing unique source markers without
rewriting those declarations. They SHALL verify the expected declarations
and absence of HTTP bootstrap/listen code before importing the owned module.
They SHALL NOT import the listening server.

THE FIXTURES SHALL use fresh project-local directories with synthetic journal,
agent and run-record files. They SHALL supply explicit owned journalRoot and
stateDir paths and an independent fixed clock. They SHALL verify the intended
whole-second mtimes and both directory orders used by precedence fixtures.
A prerequisite discrepancy SHALL be a fixture failure, not intended RED.

THE TESTS SHALL preserve path/type/content snapshots across each read and
remove only their owned fixture/extraction directory even after assertion
failure. They SHALL NOT invoke home-based discovery defaults, read operator
state/real journals/historical claims, execute journal content, start a
listener, invoke Git/npm/model/network tools, or write outside their fixture.
Existing home-discovering regressions SHALL run only in isolated owned HOME.

THE IMPLEMENTER SHALL observe meaningful pre-fix output failures and passing
controls, commit the spec/tests before the repair, obtain independent source
review, establish focused GREEN before required full/static/security gates,
and bind delivery to the actual candidate. Extraction/import/fixture/cleanup
errors SHALL NOT count as intended RED. Grouped variants reached only after
the first assertion is fixed SHALL NOT be described as individually observed
RED. Synthetic observations SHALL NOT be reported as a native incident.

THE PRODUCT CHANGE SHALL be limited to these five paths:

1. `specs/ops/dashboard-superseded-activity.md`;
2. `tests/graph-dashboard/superseded-activity.test.mjs`;
3. `scripts/graph-dashboard/server.mjs`, only the active derivation and directly explanatory comments;
4. `scripts/graph-dashboard/README.md`, only the activity clarification;
5. `governance/test-floors.json`, only a measured root-floor increase/evidence comment after accepted full verification.

All preexisting tests SHALL remain byte-identical. Runtime floor/policy,
graph/hook/skill/pipeline sources, UI, historical records, package manifests
and broader roadmap status SHALL remain unchanged. The future base placeholder
SHALL refuse use as a real execution identity until actual prior delivery.

## Acceptance criteria

### AC-1 — Superseded runs never supply live activity (REQ-1)

**Given** an owned run record naming an earlier run through resumedFrom or
priorRunIds, with that earlier run's journal ending in an accepted start
**When** the real reader builds its model **Then** selected state is
superseded, the correct cycle remains joined and active is false, both with
a fresh agent file and with no agent timing files. The fresh/timing-less
node remains running with its original evidence; exclusion does not fabricate
a terminal or stale event.

### AC-2 — Keep precedence and existing observations (REQ-2)

**Given** an earlier-run citation and a separate direct running record for the
same run **When** cycle directories are read in either order **Then** the
direct record and its cycle win and its fresh model remains active. Both
resumedFrom and priorRunIds references are covered.

**Given** an old superseded running node **When** observed after its existing
18-minute threshold **Then** it remains stale and inactive. **Given** matching
result/failed terminals, including passed:false **Then** their state/result,
validator proxy and null cycleOutcome remain unchanged. Other model fields
and owned inputs are preserved.

### AC-3 — Do not broaden the exclusion (REQ-1, REQ-3)

**Given** a fresh current running record, an absent record, or a non-sprint
run **When** modeled **Then** the prior active behavior and observation labels
remain. Existing 18-minute and 3-hour stale behavior remains. **Given** a
nonmatching status such as `Superseded` or `superseded ` **Then** it is not
normalized into the exclusion. A completed journal remains inactive through
its existing terminal semantics. No UI or authority-writing path changes.

### AC-4 — Owned, meaningful and bounded delivery (REQ-4)

**Given** source-reviewed extraction and owned filesystem prerequisites
**When** root executes the finite matrix **Then** RED consists of the expected
active true-versus-false assertions and preserved controls, with no loader or
fixture failures. Focused, unchanged regression, full and later CI evidence
remain separately attributed. Input snapshots and cleanup succeed. A floor
raise occurs only after accepted full evidence and equals its observed root
pass count. The actual delivered prior-slice base is bound before execution;
no future identity or count is established by this draft.
