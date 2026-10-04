# Assertion checking recognizes calls, not assertion-shaped text

**Spec ID:** ops/assertion-syntax
**Status:** approved (bounded Decision12 CI maintenance)
**Last updated:** 2026-10-04
**Scope:** syntax recognition in `scripts/check-assertions.mjs`, its root parser
dependencies and existing caller compatibility.

## Existing obligation and bounded continuation

Masterpiece REQ-M23 / AC-M23.1 requires a new test file with no `assert`/`expect`
calls to fail the assertion check. The existing regular expressions can admit
`const note = "expect(1)"` and can delete a real call between quoted `"/*"` and
`"*/"` text. These are source-derived defects, not evidence that a real PR
exploited them. `docs/TESTING.md` already promises the check.

This approved Decision12 maintenance slice corrects that existing CI script.
The preceding baseline-read and added-test-discovery contracts preserve their
own fixes and evidence; this later slice changes only the checker they left
unchanged. It does not approve or complete the wider masterpiece draft or
establish whole-M23 completion.

## REQ-1 — Parse the selected language without loading the test

**Enforced by:** test:tests/ci/assertion-syntax.test.mjs; job:.github/workflows/ci.yml#validate
WHEN `hasAssertion(source, filename)` inspects supplied source text, THE CHECKER
SHALL remain synchronous and SHALL select TypeScript only when the filename
ends with the case-sensitive suffix `.ts`; all other filenames SHALL select
JavaScript. An omitted filename SHALL select JavaScript, preserving the
existing one-argument `hasAssertion(source)` API. The CLI SHALL pass each
supplied filename to that selector without changing its file selection.

THE CHECKER SHALL parse JavaScript with pinned Acorn 8.18.0 using
`ecmaVersion: 'latest'`, `sourceType: 'module'` and `allowHashBang: true`.
It SHALL parse TypeScript with pinned TypeScript 5.9.3 using `createSourceFile`,
`ScriptKind.TS` and `ScriptTarget.Latest`, requiring an empty `parseDiagnostics`
array before examining calls. The root package SHALL declare TypeScript
5.9.3 explicitly as a development dependency alongside the existing Acorn
pin; the checker SHALL NOT borrow runtime workspace installation state.

THE CHECKER SHALL NOT execute or import the supplied test, resolve its imports,
load a tsconfig, create a compiler Program/type checker, transpile, emit code,
invoke a subprocess or contact a network service. `.tsx`, `.mts`, `.cts` and
JSX support are not added by this `.ts` selection rule. Parser acceptance is
syntax recognition, not certification that the current Node runtime executes
every accepted language feature.

## REQ-2 — Recognize only the finite call shapes

**Enforced by:** test:tests/ci/assertion-syntax.test.mjs; test:tests/graph/test-floors.test.mjs
WHEN a successfully parsed input contains a call-expression node, THE CHECKER
SHALL count it only if its callee is an unqualified identifier named exactly
`assert` or `expect`, or a noncomputed property access whose receiver is the
unqualified identifier `assert` and whose property identifier matches exactly
`[A-Za-z]+`. Names SHALL be compared as parsed identifier names, including
normalized identifier escapes; case remains significant.

THE CHECKER SHALL treat parentheses and optional-call/access syntax as
transparent for those shapes. In TypeScript, parenthesized, non-null, `as`,
`satisfies` and angle-bracket type-assertion expressions SHALL be transparent
around the callee or the `assert` receiver, and call type arguments SHALL not
disqualify a matching call. These are the complete transparent wrapper set; no alias, sequence,
conditional, computed-property or other receiver resolution is added.

THE CHECKER SHALL NOT count `object.expect(...)`, `object.assert(...)`,
`assert["equal"](...)`, members containing digits/underscores/non-ASCII letters,
`new assert(...)`, a tagged-template name, a function/method declaration,
property key or type signature as a matching call. A matching inner call in
one of those constructs remains a call in its own right.

## REQ-3 — Ignore data and reject parser recovery as evidence

**Enforced by:** test:tests/ci/assertion-syntax.test.mjs; test:tests/graph/test-floors.test.mjs
WHEN assertion-shaped text occurs only in a comment, string, regular-expression
literal or template text, THE CHECKER SHALL return false. A matching call in
a template interpolation, nested function body or unreachable branch SHALL
count as syntax; the checker SHALL NOT infer execution or reachability.

IF JavaScript parsing fails or TypeScript parsing reports any diagnostic,
THEN THE CHECKER SHALL return false even if recovery produced a matching call
node. It SHALL NOT fall back to regular-expression matching. Parser messages,
source excerpts and parser exception stacks SHALL NOT be printed or propagated
as the public result of such a parse failure.

## REQ-4 — Preserve the existing CLI and import behavior

**Enforced by:** test:tests/ci/assertion-syntax.test.mjs; test:tests/graph/test-floors.test.mjs; test:tests/graph/spec-status.test.mjs
WHEN invoked as `node scripts/check-assertions.mjs <file> [<file> ...]`, THE
CHECKER SHALL keep its supplied-file behavior and return exit 1 if any selected
file returns false, otherwise exit 0. Each false result, including malformed
source, SHALL retain the existing stderr line
`check-assertions: <file> has no assert(...) or expect(...) call`.
The stdout summary SHALL remain
`check-assertions: N file(s) checked, M without assertions` followed by a newline.

WHEN invoked with no files, THE CHECKER SHALL retain exit 0, empty stderr and
`check-assertions: 0 file(s) checked, 0 without assertions` followed by a newline.
Direct and symlinked CLI invocation SHALL still execute the check. Importing
the module, including when `argv[1]` names an absent path, SHALL not execute
the CLI, read test files, print a summary or exit the caller. Unreadable selected
files SHALL remain a nonzero failure; this slice does not add a new file-reader
or filesystem admission policy.

## REQ-5 — Preserve caller fixtures and surrounding gates

**Enforced by:** test:tests/ci/assertion-syntax.test.mjs; test:tests/ci/baseline-read-failure.test.mjs; test:tests/ci/added-test-discovery.test.mjs; test:tests/graph/test-floors.test.mjs
WHEN the checker gains parser dependencies, THE TEST SET SHALL preserve existing
assertions for copied-checker fixtures, ordinary JS/TS selected files, direct
imports, symlinked execution and multi-file failure. Any necessary fixture
change SHALL be limited to explicit parser-resolution prerequisites, with
the original behavior assertions retained. Missing packages, loader failures
and fixture setup errors SHALL NOT count as expected assertion refusals.

THE CHANGE SHALL preserve the CI discovery command, selected globs and filename
framing, checked baseline/diff failure propagation, successful empty-discovery
branch, floor parser, test-floor values and lowering/rename/status ratchets.
Observed new test totals may update the floor through the existing delivery
process; parser implementation SHALL NOT lower or bypass those gates.

## REQ-6 — Deliver a syntax check with explicit limits

**Enforced by:** PROCESS
WHEN this repair is delivered, THE IMPLEMENTER SHALL witness meaningful
pre-fix failures for assertion text admitted as a call and a real call lost
inside quoted comment markers, commit the requirements and regression tests
before the implementation, preserve existing assertions, obtain independent
source review and pass the required delivery gates.

THE DOCUMENTATION SHALL describe syntax recognition and parser-failure refusal,
not executed assertions, reachable assertions, imported-library authenticity,
assertion usefulness, passing tests, or whole-M23 completion. The checker is
repository CI/development tooling requiring root development dependencies;
this change SHALL NOT promise that an installation omitting those dependencies
can run it. Other masterpiece requirements and statuses SHALL remain unchanged.

## Acceptance criteria

### AC-1 — The original lexical defects are observed and corrected

**Given** an assertion-free valid test containing `"expect(1)"`, and a valid
test with a real `assert.equal` call between quoted `"/*"` and `"*/"` strings,
**when** the actual checker runs, **then** the first fails and the second passes.
The old checker must exhibit the opposite results before implementation.

### AC-2 — Data and declarations are not calls

**Given** grouped comments, quoted strings, regex literals, static template
text, function/method definitions, property keys, TS signatures, constructors
and tagged-template names without matching inner calls, **then** the checker
returns false. Template interpolation, nested and unreachable genuine matching
calls return true. None of those input modules is executed.

### AC-3 — The exact callee policy is preserved

**Given** ordinary, parenthesized and optional `assert`, `assert.NAME` and
`expect` calls plus the selected TS wrappers/type arguments, **then** they
pass. Qualified receivers, computed members, invalid member-name characters
and other wrappers do not pass merely by resembling a supported call. Parsed
escaped names obey the same exact identifier policy.

### AC-4 — JS and TS cannot borrow each other's interpretation

**Given** typed source under `.ts` versus `.mjs` or the one-argument JS API,
**then** only the selected grammar applies. The JS relational expression
`assert < 1 > (2)` is not a call; a TS generic assertion call is recognized.
Valid modern JS such as `/v` regex syntax or import attributes beside a real
call remains parseable by pinned Acorn's latest grammar. Malformed JS/TS,
including recovered matching calls and sensitive source sentinels, returns
false without leaking parser diagnostics or source contents.

### AC-5 — CLI and dependency compatibility remain real

**Given** no files, valid files, mixed good/bad files, direct and symlinked CLI
invocation, safe imports and existing copied-checker fixtures, **then** the
exit codes and output specified above remain intact. Root locked parser
availability is an explicit fixture prerequisite; package/loader failure is
not a valid negative oracle. Existing baseline/discovery/floor assertions remain.

### AC-6 — Evidence and documentation remain scoped

**Given** the implementation and delivery evidence, **then** RED precedes the
fix, focused checks exercise the actual checker with inert supplied source,
required gates and independent review are recorded, and `docs/TESTING.md`
states the syntax-only and development-dependency limits without claiming
test execution or wider roadmap completion.
