# Dashboard raw-label own properties

**Spec ID:** ops/dashboard-label-properties
**Status:** approved (bounded Decision12 read-only-dashboard correction)
**Last updated:** 2026-10-04
**Scope:** preserve admitted raw labels as ordinary own data properties with their current state references.
**Delivery base:** `e1a60601635ef4c17af0cd88177bae2cd93f0b76`.

Root selected this finite observer repair under the owner's continuation
instruction and roadmap Decision12. Final contract/test source review and
superseded-activity delivery preceded promotion. Meaningful RED and the
tests/spec commit precede implementation. This does not approve the whole
masterpiece or authorize a native Workflow launch.

## Obligation and source defect

Masterpiece REQ-M24 supplies the honest read-only observer boundary.
`specs/ops/dashboard-attempt-identity.md` REQ-2 preserves admitted raw labels
without normalization; its AC-2 and the existing empty-label-object reader
controls supply concrete compatibility obligations. This contract defines
their own-property projection, without changing reducer admission.

`buildLabelStates` admits a started event whenever its label is a string and
stores its state in a Map. `labelStatesToObject` currently assigns each entry
through `obj[label]` on `{}`. For the admitted string `__proto__` and its
object-valued state, this invokes the inherited setter: the returned labels
object has a changed prototype and no own enumerable entry for that label.
`buildRunModel` still derives the observed node from the Map, while JSON
serialization omits that prototype-only label. This is a source-derived
counterexample, not an observed native event or a global pollution claim.

The correction is confined to that projection. The current-attempt identity
guards and the separately delivered exact-superseded activity exclusion
remain in force. Their original normative texts and historical evidence
remain unchanged. No wider status, input-validation or prototype-hardening
policy is adopted.

## REQ-1 — Project every admitted raw string as an own data property

**Enforced by:** test:tests/graph-dashboard/label-properties.test.mjs
WHEN `labelStatesToObject` projects a Map produced by the existing label
reducer, THE FUNCTION SHALL return a fresh ordinary object whose prototype
is exactly `Object.prototype` and whose own keys are exactly the Map's raw
string labels, without renaming, normalization, merging or omission.

WHEN each such label is projected, THE PROPERTY SHALL be a data property with
`enumerable:true`, `configurable:true` and `writable:true`, with neither
getter nor setter. Its value SHALL be the exact current state reference
stored for that label in the Map at projection time, without cloning,
wrapping or rewriting that state. The projection SHALL NOT mutate the
input Map or its state values.

WHEN the admitted label is `__proto__`, THE FUNCTION SHALL define that
literal own data property and SHALL NOT change the returned object's
prototype. Names such as `constructor` and `toString` SHALL be ordinary own
labels under the same rule. No new label grammar or rejection is introduced.

WHEN the Map is empty, THE FUNCTION SHALL return an ordinary empty object
compatible with `{}`. Enumeration SHALL retain standard JavaScript own-key
ordering: array-index names appear in numeric order and other string keys
retain their ordinary insertion order. Universal Map insertion ordering
for integer-like names is not promised.

## REQ-2 — Retain the run model and serialization evidence

**Enforced by:** test:tests/graph-dashboard/label-properties.test.mjs; test:tests/graph-dashboard/reader.test.mjs; test:tests/graph-dashboard/attempt-identity.test.mjs; test:tests/graph-dashboard/superseded-activity.test.mjs
WHEN the real reader assembles a run model, THE MODEL SHALL expose each
admitted observed raw label as an own property of `labels`, including
`__proto__`, containing that label's current state. Ordinary serialization
of JSON-serializable model evidence SHALL retain those own labels and state
values; it SHALL NOT silently omit a label because its spelling names an
inherited property. No new serialization policy for otherwise unsupported
values is introduced.

THE CHANGE SHALL preserve all model fields and values except the corrected
own-property representation of `labels`. It SHALL preserve reducer start
and terminal admission, current-key/current-agent matching, later matching
terminal semantics, raw-label distinctions, node identity/status/result and
timing, both stale thresholds, expected/queued nodes, direct-record precedence
and cycle joins, exact-superseded activity exclusion, validator proxy,
`cycleOutcome:null` and transcript selection.

A matching result containing `passed:false` SHALL remain done. Existing
orphan, empty-label terminal lookup and malformed-input handling SHALL
remain unchanged. The projection SHALL NOT fabricate terminal evidence,
alter activity or infer proof success from an own property.

## REQ-3 — Preserve the observer boundary

**Enforced by:** test:tests/graph-dashboard/label-properties.test.mjs; test:tests/graph-dashboard/reader.test.mjs
THE DASHBOARD SHALL remain read-only and loopback-only. UI bytes, routes,
configuration, Host protection, record writers and discovery policy SHALL
remain unchanged. The repair SHALL NOT add a production export, endpoint,
dependency, executor, writer or input rejection rule.

THE README clarification SHALL describe raw-label own-property preservation
and its ordinary-object compatibility. It SHALL NOT describe the source
defect as global `Object.prototype` mutation or claim demonstrated remote
exploitation. Synthetic acceptance SHALL NOT establish native Workflow
chronology, journal authenticity, process termination, proof execution,
whole-cycle readiness or completion of M24/the masterpiece.

## REQ-4 — Verify with owned inputs and bounded delivery

**Enforced by:** PROCESS
WHEN acceptance fixtures exercise the change, THE TESTS SHALL extract the
current real reader declarations verbatim using the existing unique section
markers. They SHALL check the required declarations and exclusion of HTTP
bootstrap/listen code before importing the owned extracted module. No
production export or import of the listening server is permitted.

THE FIXTURES SHALL use synthetic events and fresh project-local directories,
explicit owned journal/state paths and an independent fixed clock. They
SHALL verify any required whole-second mtime before asserting reader output.
They SHALL preserve input Map/state values and owned path/type/content
snapshots and clean up only owned directories even after assertion failure.
They SHALL NOT invoke HOME discovery, read operator state/real journals/old
claims, execute journal content, start a listener, invoke Git/npm/model
tools or access the network. Unchanged HOME-discovering regressions SHALL
run only in the existing isolated owned HOME route.

THE IMPLEMENTER SHALL inspect extraction and fixture prerequisites before
execution, observe meaningful output RED and passing controls, commit the
spec/tests before implementation, obtain independent source review, and
establish focused GREEN before required full/static/security/exact-candidate
CI gates. Setup, extraction, import and cleanup failures SHALL NOT count as
intended RED. Grouped variants reached only after a first failure is fixed
SHALL NOT be reported as individually observed RED.

THE PRODUCT CHANGE SHALL be limited to these five paths:

1. `specs/ops/dashboard-label-properties.md`;
2. `tests/graph-dashboard/label-properties.test.mjs`;
3. `scripts/graph-dashboard/server.mjs`, only `labelStatesToObject` and directly explanatory comments;
4. `scripts/graph-dashboard/README.md`, only the raw-label projection clarification;
5. `governance/test-floors.json`, only a measured root-floor increase/evidence comment after accepted full verification.

All preexisting tests/specs, runtime floor/policy, graph/hook/skill/pipeline
sources, UI, historical records, dependencies and broader roadmap status
SHALL remain unchanged. The future delivery-base placeholder SHALL refuse
use as an execution identity until actual superseded-activity delivery.

## Acceptance criteria

### AC-1 — Own raw labels and current references (REQ-1)

**Given** an admitted `__proto__` start reduced by the real reducer
**When** the real projection is called **Then** the returned object has a
literal own data property with all three ordinary descriptor flags true,
whose value is the exact Map state, while its prototype is `Object.prototype`.
Object.keys and JSON round-trip retain the label. Matching result/failed
updates, including a later matching result after failure, project the current
state reference and preserve existing terminal semantics and inputs.

### AC-2 — Preserve owned model evidence through JSON (REQ-2)

**Given** a synthetic journal containing `__proto__` and a distinct ordinary
label under explicit owned paths **When** the extracted real reader builds
the model **Then** both observed raw labels are own properties, their nodes
retain independently asserted identity/status/result/timing and the serialized
model retains the special label/state. Other model fields, activity and owned
inputs remain as required; no listener or operator discovery is invoked.

### AC-3 — Ordinary-object compatibility (REQ-1, REQ-2)

**Given** empty or ordinary Maps, including `coder:1`, `coder:T1`, empty-string,
`constructor`, `toString` and integer-like labels **When** projected **Then**
ordinary prototype, own descriptors, exact references and empty `{}` behavior
are preserved. Numeric-index ordering follows independently specified standard
Object.keys/JSON expectations. Replacing a Map value preserves its current
reference and ordinary key position without mutating input evidence.

### AC-4 — Honest, bounded verification (REQ-3, REQ-4)

**Given** reviewed extraction and owned prerequisites **When** root executes
the finite matrix **Then** the two own-label output failures and preservation
control are distinguished from fixture errors. Focused, unchanged regressions,
full verification and later candidate CI remain separately attributed. A root
floor raise follows accepted full evidence and equals its observed pass count.
The actual prior delivery is bound before execution; no future count, merge
identity or native incident is established by this draft.
