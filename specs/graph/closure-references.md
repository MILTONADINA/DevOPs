# Closure citations in the committed proof set

**Spec ID**: graph/closure-references
**Status**: draft
**Last updated**: 2026-10-04
**Roadmap slice**: MR18-A
**Parent**: `specs/graph/M-masterpiece-standard.md` REQ-M21 / the closure-lint half of AC-M21.1.

## Scope and authority

The root agent selected this finite CI/docs/script slice under the owner's
standing roadmap-continuation instruction and Decision12. It checks literal
closure citations and their membership in the validated committed proof set.
It does not approve the whole masterpiece draft, verify that a closure is true,
or complete MR18. The freshness-hook half of REQ-M21 and AC-M21.1 remains open.

For this slice only, roadmap row18's dependency on row10 is the implemented
MR10-A/B/C1 metadata boundary. Safe command replay, RED existence/retention,
graph convergence and `/sprint` integration remain unfinished. A published
claim's validated declarations do not establish an observed passing execution,
that a commit fixes this item, or that a PR exists or merged.

There is no historical proof migration. As of2026-10-04, the current
`SHIP_BLOCKERS.md` contains no literal `CLOSED` token; its `resolved` prose
remains unchanged. The current committed manifest names one documentation
claim. No new closure or claim will be invented to make this lint nonempty.
Meaningful nonempty acceptance uses owned synthetic fixtures.

## REQ-1 — Fixed read-only invocation and selection

WHEN invoked as `npx --no-install tsx scripts/lint-closures.mjs` with no arguments,
THE LINT SHALL check `SHIP_BLOCKERS.md` and, if present, exactly
`.workflow/state/polish-backlog.md` from one captured HEAD tree.

WHEN invoked with exactly `--local-backlog`, THE LINT SHALL instead select
the local `.workflow/state/polish-backlog.md` while retaining the captured
committed ship-blocker document and committed proof authority. It SHALL NOT
also count the committed polish backlog in this mode.

The repository root SHALL be derived from the running script's location,
independently of the caller's current working directory. Both selected paths
are fixed project-relative literals. The local flag is explicit permission to
read that one named backlog, whose contents are not authenticated provenance.
There is no arbitrary-path argument, environment override, glob, directory
discovery, alternate manifest or schema. Every other argument combination fails.

THE LINT SHALL require the committed ship-blocker document. Only an exactly
absent optional committed polish-backlog path SHALL be skipped. Each present
parent in its captured tree SHALL be a directory tree; an absent parent or leaf
may establish absence, but a symlink/blob parent SHALL fail. An unreadable
Git response, nonregular entry, symlink, malformed listing or oversized blob
SHALL NOT count as absence. Both regular Git file modes100644 and100755 are
permitted under the existing committed reader. Explicit local input is mandatory.

THE LINT SHALL NOT write files, run claim commands, evaluate source, fetch refs,
make network requests, change readiness dates or alter Workflow/run records.
The only subprocess authority is the existing finite read-only Git boundary;
the pinned local tsx loader is execution infrastructure, not a claim selector.

**Enforced by:** test:tests/verification/closure-references.test.mjs

## REQ-2 — Small, explicit CLOSED item grammar

Outside fenced code and HTML comments, THE LINT SHALL support only these two
forms of a closed item:

1. A level2 or level3 ATX heading-owned block containing exactly one complete
   physical line `**Status:** CLOSED`. Its evidence belongs on one complete
   physical line beginning `**Closure evidence:** ` followed by REQ-3's value.
   The block ends at the next
   heading of the same or higher level. No descendant heading may contain its
   status or evidence; nested closed blocks SHALL fail as ambiguous. A selected
   block SHALL have no second status line. Missing, malformed or duplicate
   closure-evidence lines are structure failures under REQ-3.
2. A Markdown table with exactly the headers `Item | Status | Evidence` in that
   order and three delimiter cells each matching `:?-{3,}:?`. A row with the
   exact status cell `CLOSED` is one item; its Item cell SHALL be nonempty and its
   Evidence cell SHALL contain REQ-3's value. Leading/trailing outer pipes are
   required. Spaces/tabs adjacent to cell contents are stripped; escaped pipes,
   multiline cells and a cell containing an extra delimiter are unsupported.

For heading-form items, each status/evidence line belongs to its nearest
preceding ATX heading, at any level; only level2/3 owners are supported. An open
level2 parent with a closed level3 child counts only the child; the parent cannot
borrow the child's status/evidence. A closed parent with an open child remains
valid when its own status/evidence precede the child. A closed ancestor plus a
closed descendant refuses. Lines owned by level4 or deeper headings cannot be
borrowed by an earlier level2/3 heading.

ATX headings permit up to three leading spaces, a separating space/tab and
optional closing hashes preceded by whitespace. A heading without a supported
closed status is not itself a closure. The table separator must immediately
follow its header; subsequent contiguous pipe rows belong to that table.

THE LINT SHALL refuse every other occurrence of the standalone ASCII token
`CLOSED` outside excluded comments/fences. Token boundaries mean the adjacent
character, if any, is not `[A-Za-z0-9_]`. This includes unsupported headings,
lists, bold/quoted status variants, inline-code mentions, prose or table forms;
they SHALL NOT silently become an unselected item. A token inside an Item or
Evidence cell is likewise ambiguous. Case folding and semantic inference from
`closed`, `resolved`, `done` or historical prose are outside this grammar.

Backtick/tilde fences follow the existing finite Markdown convention: up to
three leading spaces, at least three identical delimiters, and a closing fence
of the same character with at least the opening length and only trailing
whitespace. HTML comments use literal `<!--` through `-->` in standalone blocks:
the opening delimiter has only spaces/tabs before it and the closing delimiter
has only spaces/tabs after it on their respective lines. Same-line whole comments
are permitted; mixed visible text/comment lines, nested starts or an unclosed
comment/fence SHALL fail. Thus `CLO<!--...-->SED` and comment-synthesized status
or evidence lines cannot manufacture or hide a closure. Excluded regions preserve physical-line
boundaries. A closed item SHALL NOT combine the heading and table forms or borrow
evidence from another block/row. Unrelated open items/prose need no new format.

**Enforced by:** test:tests/verification/closure-references.test.mjs

## REQ-3 — Exact citations within the selected item

WHEN an item is CLOSED, THE LINT SHALL require its entire evidence value to be
one of these forms with the literal separators shown:

- `commit:<sha>; claim:<id>` where sha is exactly40 lowercase hexadecimal digits;
- `pr:<number>; claim:<id>` where number is a canonical positive decimal integer
  of at most10 digits and id is exactly `claim-YYYY-MM-DD-NNN` under the existing
  packaged claim-ID grammar.

There are no inline links, extra prose, alternate delimiters, duplicate fields,
abbreviated claim IDs, case normalization or implicit citations. PR numbers refer
to the current repository by convention only. The cited commit and PR are
syntactic references: this slice SHALL NOT query their existence, equality with
the claim's GREEN SHA, review state, merge state or substantive relation to the
item. An item with both kinds of change citation is unsupported rather than
silently choosing one. Reusing a valid published claim on several items is
permitted and is not evidence that the claim substantively proves each closure.

THE LINT SHALL require each cited claim ID to be an accepted member of REQ-4's
validated committed set. A local ignored claim, fabricated ID or citation only
elsewhere in the document SHALL fail. Empty or malformed evidence SHALL fail.

**Enforced by:** test:tests/verification/closure-references.test.mjs

## REQ-4 — Reuse one captured committed metadata boundary

BEFORE accepting any closure result, including a zero-item result, THE LINT SHALL
validate the complete nonempty committed claim set using the existing MR10-B
publication/schema/Git/hash/anchor checks, with all declared commands inert.
All selected document blobs and that validation SHALL use one source-fixed
captured HEAD/main context for the script-derived repository root.

THE IMPLEMENTATION SHALL reuse the existing validator's publication parser and
validation logic through a small internal source-wired entry, not a second
manifest parser, a parser of human CLI output, or discovery of old local claims.
The ordinary validator's selectors, private diagnostics, schema authority,
nonempty/empty behavior, legacy functions and reproducibility formula SHALL be
preserved. No claim-controlled callback, module, command or Git expression is
introduced. Missing or invalid publication data SHALL fail even when no CLOSED
item is selected; a zero closure count is distinct from an empty proof set.

Working publication files must still match the captured committed blobs under
MR10-B. Committed document checks use captured blobs, so uncommitted document
edits cannot replace CI authority. Explicit local backlog mode is visibly the
exception for that one selected document, never for proof membership.

The Git boundary retains MR10-B's supported ordinary `.git` layout, limits,
environment isolation and no-replacement/no-network behavior. This slice does
not support worktrees or arbitrary hostile Git configurations, provide atomic
filesystem attestation, or authenticate the local `origin/main` ref remotely.

**Enforced by:** test:tests/verification/closure-references.test.mjs; test:tests/verification/committed-claims.test.mjs; test:tests/verification/claim-schema-loading.test.mjs; test:tests/reproducibility-check.test.mjs

## REQ-5 — Bounded inputs, honest counts and private diagnostics

THE LINT SHALL bound each selected document to262144 bytes inclusive and require
strict UTF8. It SHALL bound selection to1024 closed items total and physical lines
to16384 characters, excluding the LF and optional CR line terminator. Resource
overages SHALL fail before unbounded parsing. Local file reads SHALL reject
symlink components below the script root, nonregular files, hard links and
non-directory parents, and use bounded descriptor reads, no-follow where
available, identity checks and close-on-all-paths handling. Existing publication
and Git limits remain unchanged; no global object-database content scan is added.

Success SHALL exit0 with empty stderr and exactly:
`closures: references valid documents=N closed=N\n` on stdout, where each N is
a canonical nonnegative decimal count. Documents is1 or2; each selected CLOSED
item counts once. A zero closed count SHALL remain zero, not be described as
historical verification or a completed roadmap item.

Refusal SHALL exit1 with empty stdout and exactly
`closures: <category>\n` on stderr. The closed categories are `usage`, `input`,
`structure`, `publication`, `reference`. Unknown argv is usage;
unreadable/unsafe/oversized/invalid-UTF8 selected documents are input;
unsupported or ambiguous Markdown/status shape is structure. Failure while
opening or validating the committed metadata set, including its initial Git
context admission, is publication. Failure while reading a selected HEAD
document after that boundary is input, including unsafe ancestors, missing
required files, malformed Git responses and command errors/timeouts. Malformed,
missing or duplicate evidence is structure; a well-formed cited claim ID outside
the validated set is reference.
Optional absence has only the precise meaning in REQ-1.

Diagnostic output SHALL NOT contain input paths, item text, citations, parser
exceptions, command/environment values or stacks. Tests SHALL introduce one
intended fault at a time except for explicit ordering tests; only invalid argv
must fail before any input/Git access. Other simultaneous-fault precedence is
not specified. No quiet mode, warning-only bypass or ignored failure is added.

**Enforced by:** test:tests/verification/closure-references.test.mjs

## REQ-6 — Integrate the finite lint without historical migration

THE REQUIRED `validate` job SHALL invoke the bound local CLI after existing
committed-metadata checkout/ref preparation, using its locked tsx dependency and
propagating lint failure. CI SHALL use the default committed selection without
reading an ignored local backlog or introducing a new network request. Existing
required-context names, scanner/model policy and metadata validation remain.

**Enforced by:** test:tests/verification/closure-references.test.mjs; job:.github/workflows/ci.yml#validate

## REQ-7 — Preserve the remaining roadmap boundaries

THE DOCUMENTATION SHALL explain both invocations, the exact item/evidence
grammar, the current zero selection, metadata-only assurance and unchanged
freshness behavior. Existing ship-blocker/readiness history SHALL remain intact;
no relabeling, invented closure, retargeted historical claim or broad proof
publication is allowed. A separate focused lint result SHALL not substitute for
the existing committed-claim metadata gate.

THE DELIVERY SHALL keep masterpiece REQ-M21 `UNENFORCED` while its freshness
obligation remains open, recording the delivered citation lint only as a scoped
implementation note and in this dedicated spec. Whole MR18 and MR10 SHALL remain
open. This slice SHALL NOT edit the freshness hook, `.claude/settings.json`,
Workflow, run-record code, old proof claims, operator approvals or signing keys.

THE DELIVERY SHALL follow Decision12: meaningful acceptance RED before fixes,
tests/spec committed before implementation, required checks at the candidate,
exact-PR/full-SHA approval and independent security review. Source-only planning
and owned synthetic examples SHALL not be reported as real closure evidence.

**Enforced by:** PROCESS

## Acceptance criteria

### AC-1 (REQ-1, REQ-4)

Owned copied-script/validator fixtures demonstrate committed default selection,
exact optional absence, mandatory ship-blocker refusal and explicit local
backlog substitution. Changing CWD does not select another repository. Uncommitted
or staged document edits do not replace HEAD data; the explicit local case reads
only its named file. Unknown argv fails before Git. A captured-ref race fixture
shows documents and proof membership use the original captured IDs.

### AC-2 (REQ-2, REQ-3)

Nonempty heading and table positives pass with commit and PR citations. Missing
claim, missing change citation, malformed/duplicate evidence, invalid SHA/PR/ID,
unknown or local-only claim, and evidence in another row/block fail. A multi-item
fixture with one invalid item fails. Unsupported CLOSED prose/list/heading,
nesting/competing forms, duplicate status and malformed selected tables fail.
Closed examples in comments/fences are excluded; unclosed regions fail. Ordinary
open items and preserved historical resolved prose remain unselected.

### AC-3 (REQ-4)

Real owned committed publication fixtures, not a stubbed accepted-ID list, prove
nonempty full validation and inert command text. Empty/missing publication,
changed bound member and invalid selected metadata refuse. Unknown membership
cannot be admitted through an ignored old-claim directory. Existing MR10-A/B/C1
selection/schema/hash assertions remain intact under the narrow shared-code
seam; no raw replay or RED Git lookup is introduced.

### AC-4 (REQ-5)

Owned inputs exercise inclusive caps and overages, invalid UTF8, symlink final
and ancestor paths, directories/hard links, unsupported extra path arguments and private
sentinels. Correct stdout/stderr/exit categories are asserted without matching
raw input. File-tree comparison demonstrates no lint writes. Success with zero
CLOSED items is separately asserted and still requires a valid nonempty proof set.

### AC-5 (REQ-6, REQ-7)

The candidate's CI source invokes the fixed local default lint after preparation
and propagates failure. The real committed candidate reports its measured
document/CLOSED counts without history changes; owned nonempty positives remain
the substantive behavior proof if the current production selection stays zero.
Required candidate checks and independent review pass before delivery; the
roadmap and M21 annotation continue to disclose the unfinished freshness half.

## Source-fixed implementation seam and fixture prerequisites

The agreed small API is `openValidatedPublication(root, recomputeHash)` in the
existing `verification/committed-claims.ts`, returning only after complete
validation `{head, claimIds, readHeadBlob(file, cap, optional = false)}`.
`claimIds` is a frozen array of successful validated IDs. The reader closes over
the same real Git context and its captured HEAD, returning Buffer or null only
for optional exact absence. Existing `validateCommitted(selection, callback)`
retains its CWD authority, selected/all behavior and error projection through
shared private code. Manifest read/parse precedes context creation as today.

The lint supplies the fixed adapter to import-safe
`verification/reproducibility-check.ts::compute(git_sha, test_command,
environment ?? {})`. It never imports the side-effectful validator CLI. The
four legacy Git/files/replay/hash functions and the hash formula stay unchanged.
`committed-git.ts` gains only a narrow optional regular-blob reader, with the
parent-tree/absence distinction in REQ-1; the strict reader remains unchanged.
The local-only backlog reader adds the nlink1 guard required by REQ-5 without
changing the older shared reader's hard-link policy for claims/schema.

New fixtures copy exactly the lint plus `claim-input.ts`, `committed-claims.ts`,
`committed-git.ts`, sibling `claim-schema.yml` and `reproducibility-check.ts` into
one owned repository layout and use the locked absolute tsx CLI. Existing
schema/committed fixture rosters stay unchanged: only the new lint imports the
hash helper. They must be reassessed before RED if implementation changes this
dependency direction. No dependency, generic parser or executor is added.

Tests must first assert the lint feature exists so absent modules or fixture
failures cannot masquerade as meaningful RED.
