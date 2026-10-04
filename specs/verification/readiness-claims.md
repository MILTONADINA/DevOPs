# Readiness declaration citations

**Spec ID:** verification/readiness-claims
**Status:** approved (bounded Decision12 CI and document citation checks)
**Last updated:** 2026-10-04
**Roadmap slice:** MR12-B, document-citation portion of M10 / AC-M10.1

## Scope and explicit M10 clarification

The root agent selected this bounded CI/docs/script slice under the owner's
standing continuation instruction and Decision12. This bounded contract is
approved for the tests-first delivery route below. No whole-masterpiece
approval or semantic readiness verification is implied.

This contract narrows M10's document-lint phrase “any of the literal state
tokens” to explicit machine declarations, four reserved stronger tokens and
closed current version Status cells defined below. Ordinary `implemented` and
`verified` verbs are not declarations. Negative, quoted or historical prose
does not receive inferred natural-language meaning. Nonpositive process labels
are not canonical claim states. These distinctions are explicit policy, not
silent parser exceptions.

M10's convergence, work-graph and deployment-evidence validator requirements
are unchanged and unfinished. This lint checks exact **declared-state**
association only; it does not rank states or prove their truth. `fixed_not_live`
matches only itself and is never promoted to deployed. M10 remains UNENFORCED;
whole MR12/MR10 and the masterpiece remain open. MR12-A's six-value schema,
optional state, existing hash and metadata-only assurance remain unchanged.

Current source has no selected canonical declaration, but has two current
SHIPPED cells without machine-associated claim states. They require the honest
REQ-7 migration, not a history exemption or invented claim. AC-M10.1's old
LAUNCH_READINESS line241 address is obsolete; acceptance uses current source
and owned nonempty fixtures, not a claim that the old text is still present.

## REQ-1 — Read two captured documents through one validated publication

**Enforced by:** test:tests/verification/readiness-claims.test.mjs

WHEN invoked with no arguments as
`npx --no-install tsx scripts/lint-readiness-claims.mjs`, THE LINT SHALL derive
the project root from its script location and read exactly
`docs/LAUNCH_READINESS.md` and `SHIP_BLOCKERS.md` from one captured HEAD.
Both documents are required regular Git blobs under the existing contained
reader. There is no local/working-document override, environment selector,
alternate path, claim discovery, supplied schema or configurable command.
Every other argument combination SHALL fail before any input/Git access.

BEFORE accepting any document result, including zero declarations, THE LINT
SHALL open the full nonempty committed publication using the source-fixed
`openValidatedPublication(root, recomputeHash)` seam. All existing member-byte,
schema, ID, hash, target ancestry/change and spec-anchor checks must succeed.
Documents and declarations SHALL share that factory's captured HEAD/main
generation. Dirty/staged document bytes SHALL NOT replace captured blobs;
dirty bound publication bytes SHALL retain their existing refusal.

The lint SHALL extend this existing factory only with `claimDeclarations`,
a frozen array of individually frozen `{id}` or `{id, state}` objects copied
after each selected claim completes validation and exposed only after all
publication results pass. The optional state SHALL be copied only when
`Object.hasOwn(claim, "state")` is true after schema acceptance; absent state
SHALL remain absent, with no inherited/default value projected. The private validator may return results plus this
projection; public `validateCommitted` SHALL retain its original results.
`Claim` may gain the optional six-value TypeScript state member already allowed
by the schema. No second YAML parse, working-claim reread, new Git context,
human-output parsing, inferred/default state or raw proof-field exposure is
permitted. The existing source-wired import-safe hash adapter SHALL be reused.

THE CHANGE SHALL preserve the existing schema, hash formula, committed Git
reader, legacy validator functions, selectors and `lint-closures.mjs` behavior.
No proof command, network request, readiness mutation, Workflow or journal
operation is authorized by this lint.

## REQ-2 — Bound input and identify current tables and exact history

**Enforced by:** test:tests/verification/readiness-claims.test.mjs

THE LINT SHALL strictly decode UTF-8 and admit at most262,144 raw bytes per
document and32,768 bytes per physical line, inclusively. Line bytes exclude a
terminal LF or CRLF; an unterminated final line counts in full. These bounds
apply before exclusions. Existing publication/Git bounds remain unchanged.
Syntax may treat CRLF as physical line endings, but historical matching below
uses original bytes without normalization.

Outside REQ-3's excluded regions, LAUNCH_READINESS SHALL contain exactly one
literal physical heading:
`## Masterpiece roadmap to v1.0.0 (Session 14 binding)`.
Its section ends at the next level1/2 ATX heading. It SHALL contain exactly one
current version table, with at least one version row. Missing, malformed,
duplicate or misplaced current tables/headings SHALL fail. Another nonhistorical
Version table elsewhere in LAUNCH_READINESS SHALL fail rather than be ignored.
SHIP_BLOCKERS may contain zero version tables; each selected one SHALL meet
the same supported table grammar.

A selected table begins with a pipe-delimited physical header whose first
trimmed cell is literal `Version`. The complete header SHALL be exactly:
`Version | Theme | Status | Hours done | Hours remaining | Progress | Ship gate`.
Its immediately following seven delimiter cells SHALL be exactly
`---`, `---`, `---`, `---:`, `---:`, `---:`, `---` in order.
Header/delimiter/body lines require leading and trailing pipes and exactly
seven cells; only cell/line-edge spaces/tabs are trimmed. Escaped pipes,
multiline cells or an extra literal delimiter are unsupported. Contiguous
pipe rows form the body; a malformed selected row is not silently skipped.

A version row's first cell SHALL be a literal `v` followed by decimal major,
dot, decimal minor, dot, decimal patch or `x`, optionally enclosed in exactly
one whole-cell bold pair. The other five non-Status cells are text, not
readiness evidence; REQ-3 declaration selectors still apply within them.
The only aggregate row is the exact current first cell `**TOTAL to v1.0.0**`
with Status exactly `—`; it counts neither as a version nor a process row.
At most one such aggregate is permitted per table. REQ-3 validates every
version Status cell, including both existing SHIPPED cells before migration.

Only LAUNCH_READINESS may exclude one exact existing historical version table:

- It immediately follows the current table, separated by the existing single
  blank physical line and then the exact351-byte notice whose SHA256 is
  `d928bf9e652eafd8e7518b80697f2f01a2a494e1bf0a03769bc93c48c0b1239d`.
- The notice begins `**History: the rows as they stood before the 2026-09-26
  redefinition.**` on its existing physical line and states the source
  `378059e` and that the table is not current status. It includes the blank
  line before the historical table. Matching is the full raw notice bytes,
  not a prefix or mutable heading.
- The immediately following table is exactly28,491 bytes, SHA256
  `0714ab707a6e2c09cbb84483d4d571b467bfa98227b96a9ef6e3ddfa1fc0c8a9`.
  Its existing old inline-code pipes need no grammar repair.

The complete block may be absent, including in minimal owned fixtures. An
observed notice prefix, partial block, changed notice/table, duplicate or moved
block SHALL fail; it is not ordinary ignored prose. The reserved notice prefix
is `**History: the rows as they stood before the 2026-09-26 redefinition.` at
the start of a raw physical line. Detection of this reserved prefix SHALL occur
before fence/comment exclusion, so fencing or commenting a recognized moved
or duplicate notice does not hide it. A generic History heading grants no
exemption.
Only the exact matched notice/table span is excluded; content following it
is scanned normally. No current status row is covered by this exception.

## REQ-3 — Select finite declarations and closed process statuses

**Enforced by:** test:tests/verification/readiness-claims.test.mjs

THE LINT SHALL use these exact case-sensitive forms:

```text
C  = implemented | verified | code_converged | release_ready |
     fixed_not_live | production_complete
U  = code_converged | release_ready | fixed_not_live | production_complete
ID = claim-YYYY-MM-DD-NNN (the existing full claim-ID grammar)
K  = C, plain or enclosed in one single-backtick pair
A  = K + "; claim:" + ID
```

There is one literal ASCII space after the semicolon and none after `claim:`.
IDs have exact full length, without a suffix, abbreviated range or shorthand.
No escape/entity decoding, trimming inside K/ID, case folding or hyphen
conversion is permitted.

1. Each current version Status cell SHALL be one complete A or an admitted
   process status below. A canonical cell permits no extra prose or field.
2. A physical line beginning after spaces/tabs with exactly `State:` or
   `**State:**` SHALL be exactly that label, one ASCII space, then A, with only
   optional outer spaces/tabs. Unknown state, missing citation and extra fields
   refuse; once the prefix is selected, it cannot become an ignored line.
3. A single-backtick span containing exactly C outside those complete fields
   SHALL require the immediately following `; claim:ID`. Canonical contents in
   a longer backtick delimiter are unsupported and SHALL refuse.
4. Each bare U token outside excluded regions SHALL likewise be an A with an
   immediately adjacent citation. Its boundaries are start/end or a character
   outside `[A-Za-z0-9_]`. Quotation marks and blockquote prefixes confer no
   exemption. Ordinary bare `implemented`/`verified` verbs are unselected.

For inline-code/bare-token declarations, the atom SHALL end at the
horizontal-trimmed physical line or table-cell boundary. No punctuation suffix,
second citation/field, trailing prose or ID prefix followed by other characters
is accepted. Prose before such an atom is permitted. A citation cannot be
borrowed from the next line, another cell, another item or the document as a
whole. A span already parsed as a complete field/inline declaration SHALL
count once rather than again as a bare U token.

Nonpositive version statuses SHALL start with exactly one of `IN PROGRESS`,
`NOT STARTED`, `DROPPED`, `EVIDENCE PENDING`, plain or enclosed in one exact
bold pair. The prefix ends at the cell end or a literal ASCII space followed
by notes; `IN PROGRESS:` additionally supports its existing colon-plus-space
notes. No other process prefix is accepted. Notes are not an inferred state,
but selected declarations within them still obey all rules above. Unknown or
unsupported positive statuses, including SHIPPED/DONE/READY, SHALL refuse.
Attaching a claim ID to SHIPPED SHALL NOT infer a canonical state.

The lint SHALL exclude only proper closed fences/comments and the exact REQ-2
history span. The finite fence convention matches the existing closure lint:
an opener has zero to three leading ASCII spaces followed by a maximal run
of at least three identical backticks or tildes. Any remaining text on that
opening line is permitted uninterpreted info text. A closer has zero to three
leading ASCII spaces, the same delimiter character repeated at least the
opening length, and only trailing spaces/tabs. Fence contents are excluded
until that closer; the reserved raw history prefix check remains mandatory. Standalone HTML comments start with `<!--` preceded
only by spaces/tabs and end with `-->` followed only by spaces/tabs; same-line
whole comments are permitted. Nested/unclosed comments, unclosed fences and
mixed visible/comment lines SHALL fail. Raw physical boundaries SHALL remain;
stripping comments must never synthesize or hide declaration/status text.
Indented prose, inline quotes and blockquotes are not additional exclusions.

## REQ-4 — Require exact declared-state support without semantic promotion

**Enforced by:** test:tests/verification/readiness-claims.test.mjs

WHEN a selected A cites ID, THE LINT SHALL require that ID in the fully
validated immutable declarations and require its supplied state exactly equal
to C. Unknown ID, omitted state or unequal state SHALL fail. There is no state
ordering, upward/downward support, fallback ID or implied state; in particular
fixed_not_live matches only fixed_not_live.

Accepted membership/equality SHALL mean declared metadata association only.
No claim command, proof output, deployment URL, journal, convergence command
or work-graph status is read or executed. A matching production_complete
declaration does not establish deploy evidence; semantic M10 remains open.
Process labels and the aggregate do not become canonical declarations.

## REQ-5 — Report exact counts and private fixed diagnostics

**Enforced by:** test:tests/verification/readiness-claims.test.mjs

WHEN all checks pass with at least one selected declaration, THE LINT SHALL
exit0, emit empty stderr and exactly this stdout line:
`readiness: references valid documents=2 declarations=N process_rows=P history_tables=H\n`.

WHEN all checks pass with zero declarations, THE LINT SHALL exit0, emit empty
stderr and exactly:
`readiness: none selected documents=2 declarations=0 process_rows=P history_tables=H\n`.

N/P are canonical nonnegative decimal counts. N counts each selected atom
once; P counts admitted nonpositive version rows across both documents, not
the aggregate; H is0 or1 for the exact historical table. The current proposed
migration constructs P9/H1/N0, but only a later actual run may report those
observed results. Zero declarations SHALL NOT be reported as ready or complete.

Refusal SHALL exit1, emit empty stdout and exactly
`readiness: <category>\n` on stderr. Categories are `usage`, `input`,
`structure`, `publication`, `reference`:

- Unknown argv is usage, before any input/Git access.
- Publication factory/context/metadata failure is publication.
- Subsequent selected-document Git read/type/absence/cap/UTF-8 failure is
  input, including malformed Git responses/timeouts. Line-cap failure is input.
- Markdown/table/history/declaration grammar, missing or malformed citation,
  duplicate/ambiguous structure or unsupported status is structure.
- Well-formed unknown ID, absent declared state or unequal state is reference.

No paths, source excerpts, IDs, parser errors, proof commands/environments or
stacks SHALL be printed. Other simultaneous-fault precedence is unspecified;
tests introduce one intended fault except explicit ordering cases. No warning
mode, quiet bypass, supplied acceptance list or import-time CLI effects is added.

## REQ-6 — Run the actual candidate documents in required CI

**Enforced by:** job:.github/workflows/ci.yml#validate

THE REQUIRED validate job SHALL run
`npx --no-install tsx scripts/lint-readiness-claims.mjs` after its existing
full checkout/ref preparation and committed metadata setup, propagating failure.
The step name SHALL be
`Validate readiness declarations (specs/verification/readiness-claims.md REQ-6)`.
It SHALL read the real captured candidate documents and existing nonempty
publication, reporting actual declaration/process/history counts. The existing
committed019 metadata step remains separate; no real claim/state publication
change is permitted merely to make this new lint pass.

Required-context names, model/scanner policy, checkout preparation and other
CI behavior SHALL remain unchanged. No network beyond existing CI preparation
or new package dependency is introduced. A separate fresh-clone local run is
not mandatory when focused shared regressions and actual exact-candidate CI
resolve the relevant risks.

## REQ-7 — Preserve evidence and follow the bounded delivery route

**Enforced by:** PROCESS
**Enforcement note:** The readiness tests support preservation; reviewed migration, exact-head CI and delivery evidence complete this procedural requirement.

THE DOCUMENT MIGRATION SHALL change only the two current SHIPPED Status cells
to EVIDENCE PENDING plus a short nearby explanation. It SHALL preserve the
recorded release events/tag/commit locators and all historical snapshot bytes.
The new status means no machine-supported readiness state is cited; it SHALL
NOT deny that a recorded release occurred or claim that it was reverified.
Pending/dropped/not-started rows SHALL NOT be promoted into canonical states.
No claim or state may be invented, retargeted or borrowed to satisfy the gate.

Other consumer changes SHALL be surgical: CLI/grammar/metadata-limit guidance,
a bounded threat note, roadmap row12's partial progress and M10 explanatory
note retaining UNENFORCED. MR12-A/MR10 semantic limits and whole-masterpiece
draft status remain. No historical local claims, journals, operator approval
data, signing keys, hooks, Workflow or run-record code is part of this slice.

THE IMPLEMENTER SHALL preserve every existing test and prior schema/hash/Git
policy. New tests SHALL use the real lint/shared modules and nonempty owned
committed publication fixtures, not a fabricated accepted-ID list. The copy
roster is the new lint plus claim-input.ts, committed-claims.ts, committed-git.ts,
claim-schema.yml and reproducibility-check.ts, using the existing locked tsx
loader. Fixture source is copied unchanged; target/readiness/publication data
is synthetic and explicitly staged in the owned repository, except that
fixtures may copy only the exact source-bound historical notice/table as inert
format data for REQ-2. No historical claim link or reference in that copied
block is followed or validated. Existing isolated
Git/environment/maintenance controls remain prerequisites.

Decision12 delivery SHALL retain meaningful RED before fixes, a tests/spec
commit before implementation, reviewed focused GREEN, required candidate
checks, full-head approval and independent security review. Missing modules,
bad fixture setup or a stale line241 assumption SHALL NOT count as RED.
Source-derived counts and owned examples SHALL NOT be reported as actual
readiness, proof execution or required-CI observations.

## Acceptance criteria

### AC-1 — Real publication and captured document authority

Owned nonempty committed fixtures exercise script-root/no-argument selection,
both required documents, different CWD, uncited invalid member, dirty/staged
publication and captured-document authority. Invalid argv fails before Git.
Dirty working docs and later ref movements cannot replace captured inputs.
The new immutable projection preserves omission and cannot expose declarations
from a partially invalid set; public validator/old closure outputs remain.

### AC-2 — Current tables and exact historical exception

At least one supported version row is required under the exact unique LR H2.
Missing/malformed/duplicate/misplaced heading/header/delimiter/rows refuse;
SHIP zero tables and additional valid selected tables are supported. TOTAL's
exact aggregate form is distinct. Complete unchanged adjacent history passes
and counts1; absent history passes minimal fixtures; partial/changed/duplicate/
moved history refuses. Content after a valid history block is still scanned.
The retained real table's25,783-byte line passes the selected32KiB cap.

### AC-3 — Finite declarations and exact same-item equality

All six states have nonempty supporting positives through owned claims; table,
labelled-line, code and bare-U forms are covered. Missing/malformed/abbreviated
citations, suffixes, extra fields, borrowed/global IDs, absent state, unequal
state and unknown ID refuse. fixed_not_live cannot support another state.
Overlapping selectors count one atom. Long-backtick canonical forms and
unsupported positive Status values including existing SHIPPED refuse.

### AC-4 — Process text, exclusions and bypass controls

Current nonpositive prefix forms and ordinary verified/implemented verbs,
negative statements and “live dashboard” remain unselected. Reserved tokens
inside quote/blockquote text still require their own citation. Proper fenced
examples and standalone comments are excluded; unclosed/mixed/synthesized
forms refuse. Process notes cannot hide a reserved/code declaration. Zero
declarations still validate a nonempty publication and report none selected.

### AC-5 — Bounds, privacy and inertness

Inclusive file/line caps, strict UTF-8, unsafe/missing selected blobs and fixed
private error categories are exercised with owned data. Raw sentinel text,
commands, paths and IDs never leak on refusal. Source/input snapshots and an
inert command sentinel show no writes or replay; import does not invoke the
CLI. Existing metadata/schema/hash/closure regressions remain unchanged.

### AC-6 — Honest migration and actual required CI

An inverse/source comparison preserves historical table/notice bytes, recorded
release locators, old tests and all unrelated current-doc text. Only two Status
cells and the short explanation change in LAUNCH_READINESS; SHIP history need
not change. Exact-candidate native CI runs the new bound step on real captured
documents/publication and reports actual process/declaration/history counts.
Synthetic positives are separately labelled; neither zero selection nor a
metadata-equality result completes M10/MR12 or revalidates release history.
