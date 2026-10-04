# Dashboard current-attempt terminal identity

**Spec ID:** ops/dashboard-attempt-identity
**Status:** approved (bounded Decision12 read-only-dashboard correction)
**Last updated:** 2026-10-04
**Scope:** preserve the current attempt when stale or mismatched terminals arrive.
**Delivery base:** `af5858b7500879db8b73f4860b093d7d28229753` (PR253).

Root selected this finite observer repair under the owner's continuation
instruction and roadmap Decision12. Final contract/test source review and PR253
delivery preceded promotion. Meaningful RED and the tests/spec commit precede
implementation. This does not approve the whole masterpiece, reopen MR15's
recorded delivery, or authorize a native Workflow launch.

## Source defect and scope

`buildLabelStates` in `scripts/graph-dashboard/server.mjs` replaces a label's
current state on `started`, but applies `result` and `failed` using only the
retained key-to-label mapping. An earlier agent's terminal can overwrite a
newer attempt's state. A retained old key can also address a label that now
has a different key. `buildRunModel` then uses the overwritten agent for
label timing and can expose its result as `validatorOutcome`.

This is a source-derived counterexample, not a witnessed historical Workflow
incident. Masterpiece REQ-M24 requires honest observer state; AC-M24.1 retains
its existing age/run-record controls. The identity clarification below is a
narrow later correction, with those normative texts preserved. The separate
`proof-inputs.md` REQ-4 supplies consistent current-attempt terminology but
its strict whole-journal validation is not adopted by this tolerant reader.

## REQ-1 — Apply terminals only to the current key and agent

**Enforced by:** test:tests/graph-dashboard/attempt-identity.test.mjs
WHEN `buildLabelStates(events)` processes a `result` or `failed` event, THE
READER SHALL use the existing key-to-label lookup to locate the candidate
label. THE READER SHALL apply that terminal only when a current state exists
for that label and both `current.key === event.key` and
`current.agentId === event.agentId` hold using JavaScript strict equality.

IF no candidate label/current state exists, or either identity comparison
fails, THEN THE READER SHALL ignore that terminal without changing any
label's state. It SHALL NOT change the current label, status, phase, key,
agent ID or result in response to the ignored terminal. Ignoring it SHALL
NOT produce a new diagnostic or fail the whole run.

These comparisons concern the identity values the existing reader already
stores. They add no coercion, normalization, identifier grammar, uniqueness
rule or resource cap. A late terminal must remain ignored whether the current
attempt is still running or already has a matching terminal.

## REQ-2 — Preserve start and matching-terminal behavior

**Enforced by:** test:tests/graph-dashboard/attempt-identity.test.mjs
THE READER SHALL preserve the existing `started` branch's admission and
replacement behavior. In particular, a later accepted start SHALL reset that
label to running with its own key, agent ID, phase and null result. Raw labels
SHALL remain distinct without normalization.

WHEN a terminal matches the current key and agent ID, THE READER SHALL retain
its existing semantics: `result` sets done and `event.result ?? null`;
`failed` sets errored and null result. A result containing `passed:false`
SHALL still be done, since invocation completion is not proof success.
A failed attempt followed by a fresh start and a matching result SHALL still
resolve to the new attempt's done state. Orphan terminals SHALL remain ignored.

THE READER SHALL preserve malformed JSON-line tolerance and existing malformed
started-event handling. Repeated terminals with the same current key and
agent ID SHALL retain the existing later-terminal-wins behavior; this slice
does not introduce first-terminal finality or require well-formed native
chronology. An accepted start reusing an agent ID with a different key remains
accepted under the current start policy; it is a useful independent key-check
fixture, not a claim that such a sequence is valid native Workflow output.

## REQ-3 — Preserve current identity in the existing run model

**Enforced by:** test:tests/graph-dashboard/attempt-identity.test.mjs
WHEN `buildRunModel` consumes a journal containing an ignored terminal, THE
MODEL SHALL derive label timing and node state from the retained current
agent and state. An in-flight current validator SHALL have null
`validatorOutcome`, even if a superseded agent later supplies a result. A
matching current validator result SHALL remain available through that
existing field. `cycleOutcome` SHALL remain null.

THE CHANGE SHALL preserve active/stale derivation, both existing age
thresholds, expected/queued-node derivation, run-record/cycle joins,
superseded-run handling, transcript selection, routes, configuration,
loopback binding, Host protection and read-only behavior. It SHALL NOT add a
production export, new endpoint, CLI, dependency or writer. All existing
tests SHALL remain unchanged.

This repair provides current-identity consistency, not agent-work validation,
proof execution, readiness, journal authenticity or cross-role freshness.
Key/label corruption policy, strict malformed identity rejection, duplicate
terminal rejection, transcript path admission, whole-cycle result persistence,
native chronology validation and safe execution remain outside this slice.

## REQ-4 — Prove the repair with owned inputs and limited delivery

**Enforced by:** PROCESS
WHEN acceptance tests exercise this change, THE FIXTURES SHALL extract the
current real reader source using its existing exact section markers, without
rewriting that source or reimplementing its reducer. They SHALL assert that
the expected reader declarations are present and HTTP bootstrap/listen code
is excluded before importing the owned extracted module. They SHALL NOT
import the live server or launch a listener.

THE NEW TESTS SHALL use only synthetic event arrays and fresh owned fixture
files under the project test workspace. A model fixture SHALL use its own
journal and agent files. Tests SHALL compare input paths and content before
and after reads and remove only their owned extraction/fixture directory.
They SHALL NOT call home-based run discovery, enumerate or copy real journals,
read historical claims/operator state, launch Git/npm/model/network tools,
or execute any event/result content. Existing home-discovering dashboard
regressions SHALL run only in an isolated owned HOME containing no real
Workflow journals.

THE IMPLEMENTER SHALL witness meaningful pre-fix state/output failures and
passing preservation controls, commit the new spec/tests before the repair,
obtain independent source review, establish focused GREEN before the required
full/static/security gates, and bind delivery to the exact candidate. A
missing extraction marker, module/import failure, fixture error or listener
failure SHALL NOT count as intended RED. Synthetic observations SHALL NOT be
reported as an actual native Workflow incident or a new Workflow execution.

THE PRODUCT CHANGE SHALL be limited to the new spec/test, the reader's two
terminal branches and directly explanatory comments, a concise dashboard
README clarification, and a measured root-floor/comment update after an
accepted full run. Runtime floor/policy, graph/hook/skill/pipeline sources,
current historical records and other roadmap status SHALL remain unchanged.
No floor increase or future commit identity is established by this draft.

## Acceptance criteria

### AC-1 — Ignore stale and mismatched terminal identities (REQ-1)

**Given** a current start B after an earlier start A for the same key/label
**When** A supplies a later result or failed event **Then** B's state remains
unchanged, both while B is running and after B's own matching terminal.
**Given** the same label started under a new key while retaining the same
agent ID **When** the old key supplies a terminal **Then** that terminal is
ignored. **Given** a current key with an unknown agent's terminal **Then** the
current state remains unchanged. The key-only and agent-only mismatches
SHALL be covered independently, with result and failed variants.

### AC-2 — Preserve normal observations (REQ-2)

**Given** matching current result and failed terminals **When** reduced
**Then** they retain done/payload and errored/null behavior. A null or absent
result remains null; `passed:false` remains done. **Given** failed A, fresh
start B and matching B result **Then** B completes normally. Orphan terminals
create no label; malformed started labels remain ignored; raw labels stay
distinct. Repeated terminals for the same current identity retain their
existing ordering behavior.

### AC-3 — Project the current validator and timing (REQ-3)

**Given** an owned model journal with validator A followed by current B and
then a stale A terminal, plus separately timestamped owned agent files
**When** the real run-model reader builds the model with an explicit fixed
`now` keeping B inside the existing age threshold **Then** the node and label
retain B's identity/timing, the current validator remains running/active and
`validatorOutcome` is null. **Given** B's matching result is then appended
within the same owned fixture **When** read again **Then** that current result
is exposed, the node is done and the model's `cycleOutcome` stays null.
All model-read input snapshots remain unchanged by the reader.

### AC-4 — Owned, tests-first and honest delivery (REQ-4)

**Given** the reviewed frozen test/source generations and inspected Node,
extraction and fixture prerequisites **When** root executes the new acceptance
cases **Then** the pre-fix failures are the intended observation mismatches,
not setup/import failures. Focused and existing regression observations SHALL
be reported separately from an accepted full run and later exact-candidate CI.
The old tests and all excluded product sources remain preserved. Any floor
raise SHALL equal the observed accepted root count and retain an evidence
comment. The actual delivered recovery base SHALL be bound only after that
delivery completes; the rejecting placeholder is not a valid execution input.
