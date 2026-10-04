# Test-floor count admission

**Spec ID:** ops/test-count-admission
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** parsed count admission in `scripts/check-test-floor.mjs`, preserving
its existing parser, CLI, floor and ratchet policies.

## Existing obligation and actual defect

Masterpiece REQ-M23 / AC-M23.1 requires suite floors to reject shrunken test
counts. `docs/TESTING.md` and `scripts/check-test-floor.mjs` already describe
failure/count refusal. At the start of this maintenance change, the root parser returns `failed: null` when
the failure line is absent, but `checkFloor` checks only missing passed/total
before treating the failure count by truthiness. It can therefore succeed
and print `null failed`. It also accepts passed counts greater than total,
and digit strings converted to unsafe integers or Infinity.

These are source-derived malformed-log acceptance defects. Required CI already
propagates a failed `npm test | tee` pipeline under Bash; this contract does
not establish that a real failing suite bypassed CI. It does not authenticate
logs, prove tests executed, or complete whole M23/the masterpiece roadmap.

The previous baseline-read, added-test-discovery and assertion-syntax slices
retain their own scope, requirements and evidence. This later maintenance
changes count admission only; it does not rewrite their preservation clauses.

## REQ-1 — Require complete, finite and consistent count values

**Enforced by:** test:tests/ci/test-count-admission.test.mjs; job:.github/workflows/ci.yml#validate; job:.github/workflows/ci.yml#runtime-test
WHEN `checkFloor(suite, counts, floors)` checks a configured suite, THE CHECKER
SHALL require each of `counts.passed`, `counts.failed` and `counts.total` to be
a nonnegative JavaScript safe integer, and SHALL require
`counts.passed + counts.failed <= counts.total` before reporting success.

IF any required count is `null`, THEN THE CHECKER SHALL retain the existing
missing-count result:
`<suite>: no test count found in the output (refusing to report a pass)`.
IF any count is otherwise invalid, including undefined, boolean, string,
negative, fractional, unsafe or nonfinite values, or their sum exceeds total,
THEN THE CHECKER SHALL return a nonempty problem rather than success.
No exact new invalid-count message is mandated. New diagnostics SHALL NOT
include the source log or excerpts from it.

The existing suite-floor lookup remains unchanged. This is validation of the
three count values, not a new floor-file schema, count-container schema or
generic reader policy. Other properties on a count object do not supply or
replace those three values. JavaScript negative zero has the same admission
as zero; no separate serialization convention is introduced.

## REQ-2 — Preserve parser formats and public helper behavior

**Enforced by:** test:tests/ci/test-count-admission.test.mjs; test:tests/graph/test-floors.test.mjs
WHEN count text is parsed, `parseCounts(suite, text)` SHALL retain its existing
signature, return shape, numeric conversion, ANSI stripping, root `#`/`ℹ`
formats and Vitest summary extraction. Its existing first-matching-summary
behavior SHALL remain unchanged. In particular, root missing fields remain
`null`, and a normal runtime summary omitting a zero-failure fragment still
returns `failed: 0`; the latter SHALL not be rejected merely for that omission.

WHEN count values are admissible, THE CHECKER SHALL preserve genuine positive
failure refusal and the existing failure diagnostic, and SHALL compare the
passed count against the existing floor. At-floor and above-floor counts with
failed0 SHALL pass; below-floor counts SHALL fail with the existing diagnostic.
All-zero counts SHALL pass at floor0 and fail at a positive floor. A total
greater than passed+failed SHALL remain permitted for skipped, todo or
cancelled tests; this slice SHALL NOT require equality or parse extra counters.

The change SHALL preserve the exported `parseCounts`, `checkFloor` and
`checkRatchet` interfaces. Duplicate/conflicting summary selection, broader
log framing, log authenticity, reporter replacement and parser rewrites are
explicitly excluded.

This admission validates the parsed count values, not every raw token in the
log. The unchanged runtime extractor can recognize a positive digit suffix
inside malformed text such as `-10 passed` or `1.5 passed`. This repair does
not promise to reject those raw spellings or validate the complete summary
grammar. Direct-helper negative/fractional cases verify count-value admission,
not a new raw-token parser.

## REQ-3 — Preserve the existing CLI and surrounding policies

**Enforced by:** test:tests/ci/test-count-admission.test.mjs; test:tests/graph/test-floors.test.mjs; test:tests/graph/spec-status.test.mjs; test:tests/ci/baseline-read-failure.test.mjs; test:tests/ci/added-test-discovery.test.mjs
WHEN the actual count-checking CLI receives invalid counts, THE CLI SHALL exit
1 and print its problem with the existing `test floors:` prefix, without
printing a success summary. Valid count results SHALL retain exit0 and the
existing success-summary format. Direct and symlinked invocation and import
safety SHALL remain intact; argument and file-reading policies are unchanged.

THE CHANGE SHALL preserve the ratchet implementation and all declared
lowering/rename rules, floor values/policy, test commands and Bash pipeline,
CI baseline and added-test discovery guards, assertion checker and selected
test paths. Test-floor increases resulting from observed new tests remain the
existing delivery process, not an authorization to lower a floor.

## REQ-4 — Verify the real admission failure without changing old assertions

**Enforced by:** PROCESS
WHEN this slice is implemented, THE TEST SET SHALL exercise the actual exported
helpers and actual CLI with owned synthetic summaries. It SHALL witness
pre-fix false success for a missing root failure count, an impossible total
and an unsafe/nonfinite parsed count; existing genuine failure and valid
format controls SHALL remain. Missing files, loader failures and fixture
setup failures SHALL NOT count as RED.

THE IMPLEMENTER SHALL preserve `tests/graph/test-floors.test.mjs` and existing
baseline/discovery/assertion tests byte for byte, adding the finite acceptance
cases separately. A copied CLI fixture SHALL copy the current real checker
without modifying it in the fixture and create only an owned synthetic
`governance/test-floors.json`, logs, an import-only caller and a symlink for the
entry-point control,
without executing a test suite, importing a supplied log, invoking Git/npm or
contacting the network. It SHALL observe that selected source/log/floor bytes
remain unchanged by the read-only check.

Root SHALL inspect prerequisites and expected outcomes, witness RED and commit
the spec/tests before implementation, obtain independent source review, then
run focused GREEN before required full delivery gates. Documentation SHALL
describe malformed-count refusal without claiming log authenticity, actual
suite execution, a historical CI incident or whole-M23 completion.

## Acceptance criteria

### AC-1 — A partial root summary cannot report success

**Given** a root summary with sufficient pass/total but no failure line,
**when** the actual helpers and CLI check it, **then** they refuse using the
existing missing-count diagnostic. Each required null field is refused; the
missing-failure case must witness old-source false success before the fix.

### AC-2 — Invalid or impossible values cannot satisfy a floor

**Given** counts whose passed value exceeds total, whose passed+failed exceeds
total, or whose fields violate the selected safe-integer policy,
**then** the helper returns a problem. Actual root and runtime CLI fixtures
with impossible totals and digit strings that parse to unsafe/nonfinite
values exit1, do not print a success summary and do not echo an inert log
sentinel. At least the formerly admitted cases witness meaningful RED.

### AC-3 — Existing valid and failing outcomes retain their meanings

**Given** the established root/TAP and ANSI Vitest formats, including omitted
runtime zero failures and skipped/todo counts, **then** parser output and
at/above/below-floor outcomes remain unchanged. Genuine failures still fail,
all-zero counts pass only against floor0 among nonnegative floors, and a safe
maximum integer count is not refused merely for being large. First-match
behavior remains a preservation control, not a new authenticity guarantee.

### AC-4 — Compatibility and evidence remain scoped

**Given** direct/helper/copied-CLI/import/symlink controls and the existing
test files, **then** old assertions and ratchet behavior remain unchanged,
fixtures reach the actual checker, meaningful RED precedes the source change
and required delivery evidence identifies its exact source generation.
No package, runtime product, scanner, Workflow/hook or owner-key prerequisite
is introduced by this count-admission repair.
