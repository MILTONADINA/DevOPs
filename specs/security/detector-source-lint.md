# Detector prompt source and historical fingerprint lint

**Spec ID**: security/detector-source-lint
**Status**: draft
**Last updated**: 2026-10-03

## Scope and authority

This bounded continuation of masterpiece REQ-M25/AC-M25.1 defines a static
source-policy lint and exact fingerprint grammar. It preserves approved
[history-secret-scan-baseline.md](history-secret-scan-baseline.md) REQ-HSB-1–4:
reviewed findings retain exact fingerprints; scanner pinning, new-finding
failure and directory-fixture detection are unchanged. It does not approve or
complete the overall draft masterpiece standard.

The root agent selected the standalone lint, dependency, tests and CI invocation
under the owner's general roadmap-continuation instruction and roadmap
Decision12's low-risk CI/security-gate infrastructure route. Delivery still
requires RED first, all required checks, an approval record naming the PR/full
head SHA, and independent refute-by-default security review. This spec does not
authorize a graph-delivery bypass. Changes to `sprint-cycle.js`,
`graph-run-record.mjs` or hooks require their prescribed graph cycle and are
outside this slice.

## Static analysis boundary

The three selected calls in `.claude/workflows/sprint-cycle.js` are direct
`workflowAgent(<TemplateLiteral>, <ObjectExpression>)` calls labelled
`reviewer`, `security` and `validator`. Each prompt directly interpolates
`ENVIRONMENT_RULES` and `ownerDecisionsBlock`; the latter initializer contains
a conditional and nested template. Their schemas are separate second-argument
data, not prompt text.

Use pinned Acorn 8.18.0 as a direct dev dependency, with `ecmaVersion: 2022`,
`sourceType: 'module'` and `allowReturnOutsideFunction: true`. The last option
admits the Workflow's top-level return alongside module exports/top-level await.
Parse without stripping or executing source; no AsyncFunction wrapper, custom
JavaScript lexer, runtime package download or `npx` invocation is introduced.
CI uses its existing locked dependency install.

Static scope is deliberately explicit: inspect decoded literal string values
and template quasis within each selected first argument, plus those within the
two uniquely declared shared initializers named above. This includes literal
strings nested inside interpolation expressions and nested templates. Do not
join fragments across an interpolation/concatenation boundary. Do not traverse
schemas, unrelated roles, comments, arbitrary identifier definitions or runtime
values. This detects source literals, including JavaScript escapes; it is not
a dataflow analysis, a prompt-injection defense or proof that constructed or
caller-provided text cannot contain a phrase. A dynamic value can still contain
one, and a phrase assembled across separately defined fragments is outside this
finite check. State that limit in product documentation and review.

## Functional requirements (EARS)

### REQ-1 — Fixed read-only entry

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
WHEN invoked as `node scripts/lint-detector-prompts.mjs` with no arguments,
THE SYSTEM SHALL lint the fixed workflow source and root `.gitleaksignore`
relative to the script's project root, independently of the caller's CWD.

THE SYSTEM SHALL perform no source evaluation, imports of the Workflow,
subprocess execution, network requests, file writes or Git/history lookups.

### REQ-2 — Bounded inputs

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
THE SYSTEM SHALL admit only regular, non-symlink files reached through
non-symlink project-contained components, with an inclusive 262144-byte
workflow cap and 65536-byte ignore cap, decoded as strict UTF-8.

IF a required input is absent, redirected, unreadable, non-regular, over its
cap, invalid UTF-8 or observably changed during its bounded read, THEN THE
SYSTEM SHALL refuse rather than lint a partial or substituted input.

Implementation: inspect components with `lstat`; use
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, descriptor regular-file and size checks,
cap-plus-one bounded read, before/after identity/size/time checks, and `finally`
close. Reject hard-linked inputs (`nlink != 1`). Compare parent identities
before/after the read. These checks address visible redirection and replacement;
they are not an atomic filesystem snapshot or a hostile concurrent-operator
sandbox. The trusted parser/Node dependency closure has normal module reads;
the two-file rule describes lint inputs, not all loader filesystem activity.

### REQ-3 — Nonvacuous detector selection

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
THE SYSTEM SHALL select exactly one direct `workflowAgent` call for each of
the three literal role labels, whose first argument is an untagged template
literal and whose second argument is an object with one ordinary literal
`label` property and no spread or computed properties.

IF the parser rejects the source, THEN THE SYSTEM SHALL refuse with category
`parse`.

IF a decoded template quasi is unavailable, a required role is missing or
duplicated, a selected call has an unsupported shape, or either selected shared
initializer is missing or duplicated, THEN THE SYSTEM SHALL refuse with
category `structure`.

Use identifier or string keys for `label`; reject getters/methods and duplicate
label properties. Require both shared names as direct interpolation Identifier
expressions in every selected prompt, matching current source; object keys or
other merely same-spelled AST nodes do not satisfy this presence check. Require
exactly one simple variable
declaration for each shared name with a present initializer. This finite
selector is not whole-program call resolution: aliased/dynamic calls do not
substitute for the three required direct calls. Syntax and unsupported source
shape must fail before reporting any successful template count.

### REQ-4 — Exact finite phrase policy

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
IF any inspected literal contains one of the three prohibited phrases after
ASCII case folding and collapsing `[ \t\r\n\f\v]+` to one space, THEN THE
SYSTEM SHALL fail with the role/shared-source category and phrase identifier.

Only the three source-defined phrases are prohibited. The normalization above
is an explicit candidate clarification, so capitalization, line wrapping and
decoded escapes do not evade the same words. No stemming, synonym expansion,
semantic model, historical skip list or “approved exception” is introduced.
Comments and unrelated roles are not inspected; no quoted/discussion exception
inside an inspected literal is introduced.

### REQ-5 — Fingerprint grammar

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
THE SYSTEM SHALL ignore empty physical lines and lines whose first
non-whitespace character is `#` when classifying `.gitleaksignore` entries.

THE SYSTEM SHALL require every remaining line to be an exact four-field
`commit:file:rule:line` fingerprint: 40 lowercase hexadecimal commit characters;
a nonempty normalized relative POSIX path; rule `[A-Za-z0-9_-]+`; and a positive
canonical decimal line number within `Number.MAX_SAFE_INTEGER`.

The finite supported path grammar forbids colon, backslash, ASCII control
characters, absolute paths, empty/`.`/`..` segments and wildcard metacharacters
`* ? [ ]`. Reject leading/trailing entry whitespace; allow LF or CRLF line
endings. Comments-only or empty files have zero entries and are valid; duplicates
need not fail. This is a grammar check supporting current fingerprints, not a
complete parser for every possible Git filename or Gitleaks version.

### REQ-6 — Privacy and exit contract

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
WHEN both inputs pass, THE SYSTEM SHALL exit0 with a fixed-prefix summary
on stdout containing three selected templates and the observed fingerprint
count, with stderr empty.

IF arguments, input, parser, structure, phrase or fingerprint validation fails,
THEN THE SYSTEM SHALL exit1 with prefix `detector-lint:` and a closed category
(`usage`, `input`, `parse`, `structure`, `phrase`, `fingerprint`, `internal`)
on stderr, with stdout empty.

Diagnostics can include a fixed role/phrase identifier and safe integer line
number, but not raw source, ignore entries, parser exception text, paths derived
from input, environment values or a stack trace. Partial successes do not
change the failure exit. Counts are lint metadata, never a secret-scan count or
review verdict.

### REQ-7 — CI and preservation

**Enforced by:** test:tests/ci/lint-detector-prompts.test.mjs; job:.github/workflows/ci.yml#validate
WHEN the existing `validate` CI job has completed its locked root dependency
install, THE SYSTEM SHALL run this exact local lint as a required failing step.

THE SYSTEM SHALL preserve the existing scanner invocation/version/packs,
allowlist contents, seven historical fingerprints, detector behavior and all
other CI gates.

Add only the needed helper, test, pinned parser dependency/lock changes, CI
invocation, dedicated narrow spec and truthful documentation. No Workflow or
hook mutation, new required context, history scan, ignore rewriting, package
script indirection or shipped runtime guarantee is necessary for this slice.

## Acceptance criteria

| AC | Owned fixture / expected observation | Requirement |
| --- | --- | --- |
| 1 | Copy actual current workflow and ignore inputs into an owned script-root fixture; CLI succeeds, selects exactly three templates, reports seven entries; a different CWD gives the same result. | 1–5 |
| 2 | Independently insert each of the three phrases into each detector prompt; each exits1/`phrase`. Include one mixed-case, one wrapped and one escaped-literal variant without expanding the policy. | 4 / AC-M25.1 |
| 3 | Phrase in either shared initializer fails; nested literal interpolation fails. Same words in a comment or unrelated role are inert controls. Fragments separated by dynamic expressions are a documented non-guarantee, not a passing safety assertion. | 3–4 |
| 4 | Missing/duplicate role, non-template selected argument, duplicate/spread/computed label configuration, missing shared declaration and malformed JS refuse; nested expressions, escaped backticks and ordinary regex literals elsewhere remain parser controls. | 3 |
| 5 | Existing full fingerprints plus blank/comment lines pass. `*.test.ts`, short commit, missing field, traversal/glob path and zero/noncanonical/unsafe line numbers fail with `fingerprint`. Empty/comment-only files pass with zero entries. | 5 / AC-M25.1 / HSB-1 |
| 6 | Missing, symlinked and non-regular inputs; cap-plus-one and invalid UTF-8 inputs refuse without printing planted private sentinels. Inclusive cap controls are valid source; use real filesystem prerequisites rather than unreadable-mode assumptions under root. | 2,6 |
| 7 | Extra CLI arguments fail `usage`; unknown runtime/parser exceptions use fixed categories without raw values. A Workflow top-level throwing/writing sentinel remains unexecuted when its valid source is parsed. | 1,6 |
| 8 | CI source inspection proves exact invocation after locked install, with no conditional skip/`continue-on-error` and existing CI/scanner assertions preserved. Required CI subsequently runs the bound lint. | 7 / M25 |


## Limits

M25 completion would protect these literal prompt instructions and fingerprint
syntax. It would not complete the masterpiece roadmap, establish detector
quality, authenticate historical baseline approvals, validate historical
findings, inspect dynamic owner/backlog/results text or make an arbitrary
Workflow safe to execute. MR9 producer/replay/status gaps and MR4/5/6 owner or
authority dependencies remain separate.
