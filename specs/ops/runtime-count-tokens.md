# Runtime test-count token admission

**Spec ID:** ops/runtime-count-tokens
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** finite runtime payload recognition in `scripts/check-test-floor.mjs`, preserving selection and existing count/floor policy.

## Scope and source evidence

Masterpiece REQ-M23 / AC-M23.1 and `docs/TESTING.md` require suite-count/floor
refusal. The count-admission slice validates the three parsed values, but the
current runtime extractor can turn `-10 passed`, `1.10 passed` or `1e10 passed`
into passed10, or treat an invalid present `NaN failed` fragment as omitted0.
Those are source-derived false-success predictions, not executed RED or an
observed required-CI bypass. Required CI already preserves failed test-command
status through its Bash pipeline.

Named local Vitest5.0.1 reporter sources establish the five labels, pipe
separators, terminal parenthesized total, omitted zero statuses and live
`0 passed (0)` form. The companion source binding records those inputs;
`.workflow/state/ci-counts/runtime-token-readiness.md` preserves the analysis.
No package execution, network request or new integrity claim is implied.

This later slice changes only runtime payload recognition in
`scripts/check-test-floor.mjs`. It narrowly supersedes the
runtime raw-token-preservation/exclusion part of
`specs/ops/test-count-admission.md#req-2--preserve-parser-formats-and-public-helper-behavior`.
That slice's three-count admission, prior evidence and other preservation
obligations remain intact. Whole M23 and the masterpiece remain incomplete.

## REQ-1 — Admit the entire selected runtime payload

**Enforced by:** test:tests/ci/runtime-count-tokens.test.mjs; job:.github/workflows/ci.yml#validate; job:.github/workflows/ci.yml#runtime-test
WHEN `parseCounts('runtime', text)` selects a payload, THE PARSER SHALL require
that entire payload to match this finite grammar after existing ANSI removal:

```text
H        = ASCII space or horizontal tab
D        = one or more ASCII digits 0 through 9
label    = failed | passed | expected fail | skipped | todo
fragment = D + one literal ASCII space + label
payload  = H* fragment (H* "|" H* fragment)* H+ "(" D ")" H*
```

The words in `expected fail` have exactly one literal ASCII space between
them. Fragment count-to-label separation is exactly one literal ASCII space;
outer edges, pipe edges and the required nonempty separator before total use
only H. One ordinary trailing CR may be normalized for CRLF; this does not
admit embedded CR, newlines or other Unicode whitespace into the payload.
Leading zeros, zero-valued fragments and arbitrary label ordering are allowed.

IF the selected payload is missing or invalid, THEN THE PARSER SHALL return
exactly `{ passed: null, failed: null, total: null }`. Signs, fractions,
exponents, nonnumeric count spellings, unknown labels, empty fragments,
missing/nonterminal totals, trailing junk and invalid separators SHALL be
refused. `no tests` remains refused; `0 passed (0)` is a valid payload.

## REQ-2 — Preserve selection and finite count semantics

**Enforced by:** test:tests/ci/runtime-count-tokens.test.mjs; test:tests/ci/test-count-admission.test.mjs
THE PARSER SHALL preserve the existing ANSI stripper and runtime selection
expression `/^\s*Tests\s+(.+)$/m` exactly. This means the first payload selected
by that expression, not necessarily the first physical `Tests` header:
the existing `\s` behavior can span line boundaries. Empty-header/cross-line
framing and broader log framing are not repaired by this slice. IF the
selected payload is malformed, THEN THE PARSER SHALL refuse it rather than
searching for a later valid payload.

WHEN the selected payload is admitted, THE PARSER SHALL return only
`passed`, `failed` and `total`, using existing Number conversion. A truly
omitted passed or failed label SHALL mean zero. The first occurrence of each
of those labels SHALL supply its value; duplicate labels remain permitted,
but every fragment, including ignored later duplicates, SHALL satisfy REQ-1.
The terminal D SHALL supply total.

`expected fail`, skipped and todo are recognized metadata; they SHALL NOT
be added to passed or returned as new fields. Lexically valid large digits
in metadata or an ignored later duplicate SHALL NOT acquire a new numeric
range check. Existing safe-integer/nonnegative/sum validation SHALL continue
to act on only the three returned values. This slice SHALL NOT reconcile all
five labels with total or add duplicate/log-authenticity rules.

## REQ-3 — Preserve helper, CLI and surrounding policy

**Enforced by:** test:tests/ci/runtime-count-tokens.test.mjs; test:tests/graph/test-floors.test.mjs; test:tests/ci/test-count-admission.test.mjs
THE CHANGE SHALL preserve the root parser byte for byte, exported
`parseCounts`, `checkFloor` and `checkRatchet` interfaces, and the current
count-admission/floor/ratchet implementations. Genuine positive failures,
below-floor counts and unsafe/inconsistent selected count values SHALL
remain refused; at/above-floor failed0 and all-zero floor0 cases SHALL retain
their existing results. Omitted runtime failed0 remains valid when the whole
selected payload is valid.

WHEN malformed runtime text produces all-null counts, THE ACTUAL CLI SHALL
retain exit1, the existing stderr `test floors:` missing-count diagnostic and
no success summary. It SHALL NOT disclose source log content or excerpts.
Valid cases SHALL retain the existing exit0 success format. Direct invocation,
safe import, symlinked invocation, no-argument/argument/file handling and
unknown-suite behavior SHALL remain unchanged.

Floor policy, the runtime floor, declared lowerings/renames, test commands,
CI pipeline, baseline acquisition, added-test discovery and the assertion
checker SHALL remain unchanged. A root-floor increase SHALL be permitted only
from the measured result of an accepted full-suite run, with that evidence
recorded in the existing floor comment; no lowering is authorized. This is not
reporter replacement, log authentication or proof that a supplied log
represents an executed suite.

## REQ-4 — Verify the defect with the real parser and CLI

**Enforced by:** test:tests/ci/runtime-count-tokens.test.mjs; job:.github/workflows/ci.yml#validate
WHEN this slice is implemented, THE NEW ACCEPTANCE TESTS SHALL exercise the
actual helper and actual copied CLI using owned literal logs and a synthetic
floor. Signed, fractional/exponent and invalid-present-failure cases SHALL
provide meaningful old-source false-success RED. Loader, missing-input and
fixture setup errors SHALL NOT count as that evidence.

THE IMPLEMENTER SHALL preserve all pre-existing tests byte for byte,
including `tests/graph/test-floors.test.mjs` and
`tests/ci/test-count-admission.test.mjs`, and add the finite cases in
`tests/ci/runtime-count-tokens.test.mjs`. The CLI fixture SHALL copy the current
real builtin-only checker without modifying it in the fixture and create only
owned synthetic floor/log files, an import-only caller and an entry-point
symlink where needed for compatibility controls. It SHALL verify unchanged
selected source/log/floor bytes. It SHALL NOT execute a suite to produce logs,
import a supplied log, invoke npm/Git, or contact the network.

Root SHALL review source/prerequisites, witness expected RED, commit spec/tests
before implementation, and obtain reviewed focused GREEN before full delivery
gates. Documentation SHALL describe the selected-payload scope and remaining
selector/authenticity limits without rewriting earlier evidence or claiming
whole-M23 completion.

## Acceptance criteria

### AC-1 — Malformed raw tokens cannot become acceptable numeric suffixes

Given owned runtime floor10, actual helper/CLI cases for `-10 passed (10)`,
`1.10 passed (10)`, `1e10 passed (10)` and
`10 passed | NaN failed (10)` SHALL return all-null and refuse. At least one
case SHALL include an inert private/control-text sentinel and prove no excerpt
is emitted. Other finite lexical/total/fragment failures from REQ-1 SHALL be
grouped without altering the existing CLI diagnostic contract.

### AC-2 — Native forms, omissions and allowed formatting remain valid

Actual helper cases SHALL preserve passed-only, failed-only, metadata-only,
mixed five-label, ANSI, CRLF, H-edge/pipe/total spacing, arbitrary order,
leading-zero and explicit-zero payloads. Omitted passed/failed SHALL map to0;
metadata SHALL not count toward passed. `0 passed (0)` SHALL pass floor0 and
fail a positive floor, while `no tests` remains all-null. Existing genuine
failure, floor and selected unsafe-count refusal SHALL remain.

### AC-3 — Selection and duplicate preservation remain finite

A malformed selected nonempty payload followed by a valid summary SHALL still
refuse. First matching valid payload and first duplicate passed/failed values
SHALL remain selected. A malformed late duplicate SHALL invalidate the whole
selected payload, while lexically valid large metadata/ignored-duplicate
digits SHALL not acquire numeric admission beyond the returned three counts.
No empty-physical-header or duplicate-authenticity rule is introduced.

### AC-4 — Public consumers and source boundaries remain intact

The actual CLI SHALL retain direct/import/symlink/no-argument behavior and
fixed safe failure/success channels, with selected source/log/floor bytes
unchanged. Existing root/count/floor/ratchet and CI fixture tests SHALL remain
unchanged. Prerequisite/source bindings and RED-to-GREEN evidence SHALL clearly
separate synthetic report admission from actual test execution and historical
required-CI outcomes.
