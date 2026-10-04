# Forward enforcement-reference integrity

**Spec ID**: graph/enforcement-traceability
**Status**: draft
**Last updated**: 2026-10-04
**Roadmap**: MR17
**Parent**: `specs/graph/M-masterpiece-standard.md` REQ-M20 / AC-M20.1.

## Scope and authority

This finite CI/docs slice follows roadmap Decision12. It does not approve the
whole masterpiece draft or change Workflow, run-record, hook, settings, signing,
model funding or runtime behavior. It covers forward reference integrity only.

A present test is not an observed passing test. A present job is not a recent
successful run or a required GitHub status. A configured hook is not universal
tool coverage or a hard block. Semantic coverage, authentic evidence, current
deployment and reverse traceability remain outside this checker. The initial
annotation migration requires independent source review; related test names
alone do not establish a complete requirement.

CI baseline preparation trusts Actions' ordinary checkout metadata. It is not a
hostile Git-config sandbox. The fixed preparation captures `BASE_SHA` once,
uses read-only Git argv with an allowlisted environment and bounded command
execution, and stages only the exclusively created contained baseline file.
The checker itself has no Git or network authority.

## REQ-1 — Fixed, inert entry

WHEN invoked as `node scripts/check-enforcement.mjs` with no arguments, THE
CHECKER SHALL inspect the fixed source set relative to its own repository root.
WHEN invoked with exactly `--ratchet PATH`, THE CHECKER SHALL additionally compare
the supplied project-contained base baseline with the current baseline.
WHEN PATH is relative, THE CHECKER SHALL resolve it against the checker script
root, independently of the caller's current working directory.
THE CHECKER SHALL NOT run subprocesses, import target sources, evaluate shell or
GitHub expressions, contact a network, or write files. Unknown arguments SHALL fail.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs

## REQ-2 — Complete finite selection

THE CHECKER SHALL select every regular `.md` file recursively under `specs/graph/`
and `specs/security/`, and exactly the security tier table in `docs/SECURITY.md`.
It SHALL require nonempty files/REQ selections in both spec trees and exactly one
table whose leading headers are `Tier | When | Runs today | Gate today | Planned,
not wired`, with distinct tier keys `1`, `2`, `3` and an added `Enforced by:` column.

Outside fenced code and HTML comments, a REQ starts at a level2 or level3 ATX
heading whose first token matches `REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*`. Its block ends
at the next heading at the same or a higher level. A REQ heading nested inside
another REQ block SHALL fail; separate level2 and level3 sections are supported.
A same-file duplicate ID, unsupported heading beginning `REQ-`, missing annotation,
or duplicate annotation SHALL fail. Different files may reuse `REQ-1`. AC headings and examples SHALL NOT
manufacture REQs. Unclosed comments/fences SHALL fail instead of hiding content.

Each REQ block SHALL contain exactly one complete physical line of the form
`**Enforced by:** VALUE`. Each tier row SHALL carry `Enforced by: VALUE` in its
new column. Table cells use the existing unescaped-pipe-free row form; embedded
delimiter escapes or multiline rows are unsupported and SHALL fail. Explanatory
prose belongs outside the machine value. Existing requirement bodies, ACs,
historical descriptions and Falsified-by lines SHALL remain unchanged.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs

## REQ-3 — Typed references and explicit gaps

THE CHECKER SHALL accept either the exclusive value `PROCESS`, the exclusive
value `UNENFORCED`, or a nonempty `; `-separated list of distinct references:

- `test:tests/<path>.test.mjs` or `test:runtime/test/<path>.test.ts`;
- `job:.github/workflows/<name>.yml#<job-id>`;
- `hook:<event>:<matcher-or->:hooks/<path>.sh`.

Paths SHALL be normalized project-relative POSIX paths with no absolute form,
backslash, empty/dot/dot-dot segment, URI, query, wildcard or fragment beyond the
one job separator. Job IDs SHALL match `[A-Za-z_][A-Za-z0-9_-]*`. A reference SHALL
resolve to a regular contained file of its declared kind. Test files SHALL be
checked for existence/kind only; source assertions, execution and coverage are
separate existing gates. A job SHALL be an own key with an object value under the
selected workflow's `jobs` mapping. Parsing SHALL use the existing locked YAML
library without executing expressions, with duplicate keys, aliases, custom tags,
multiple documents and parse errors refused. Ordinary YAML1.2 workflow syntax is
supported; no new dependency or generic workflow evaluator is needed.

This explicitly replaces M20's older `ci.yml job id` spelling with a named
workflow and job: current gates also live in `security-scan.yml` and `dast.yml`.
It does not change any job's trigger, skip behavior or required-context policy.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs

## REQ-4 — Actual configured hook identity

WHEN a hook is cited, THE CHECKER SHALL find a `type: command` entry in the fixed
`.claude/settings.json` whose exact event, matcher and inert command form resolve
to that hook path. `-` denotes an absent matcher, not a wildcard. An occurrence
in a comment, echo, argument, unrelated key, wrong event/matcher or unsupported
wrapper SHALL NOT count. The hook file itself SHALL exist as a regular contained
file. Mere script presence is insufficient.

The initial supported command grammar is a closed set of reviewed current forms:
the simple SessionStart `bash "${CLAUDE_PROJECT_DIR:-.}/hooks/..." || true` form;
the exact ROOT/cd/load-baton wrapper; the exact jq/ROOT/cd/H/Bash PreToolUse wrapper
shared by the two graph gates; and the exact jq/ROOT/cd/H/Bash PostToolUse wrapper.
Each hook-path component SHALL match ASCII `[A-Za-z0-9_.-]+`, excluding empty,
`.` and `..` components; shell metacharacters SHALL NOT be admitted in that slot.
The full literal prefix/suffix around the single hook-path slot SHALL match,
together with the exact supported event and matcher. The checker SHALL NOT
interpret arbitrary Bash or discard semantically meaningful
shell text/whitespace. Fixtures SHALL use complete current wrapper bytes.

The conditional runtime TS SessionStart command is inventoried but is not a
`hooks/<path>.sh` reference. Unsupported forms require a separately reviewed
extension; they do not grant implicit enforcement. SessionStart/PostToolUse
`|| true` forms are wiring evidence only and SHALL be documented as nonblocking.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs

## REQ-5 — Bounded project inputs and private failures

THE CHECKER SHALL reject symlinks in selected paths or their in-root parents,
nonregular selected files and non-directory scope roots before reading them.
Input reads SHALL use bounded regular descriptors, strict UTF8 and no-follow
where available, with lstat/fstat identity checks and close-on-all-paths handling.
The root derived from the installed script is the trust boundary; this is not an
atomic hostile-filesystem sandbox. Hard-linked input files SHALL be refused.

Limits SHALL be inclusive: 256KiB per Markdown/workflow/settings input; 1MiB per
baseline; 512 scoped spec files; directory depth16 below each spec root; 8192 REQs total;
32 references per annotation; 1024 characters per path/reference. Each spec root
is directory depth0; depth16 and files inside it are allowed, depth17 refuses.
Referenced test or hook contents need not be read. Workflow files and settings
SHALL be read only when a job or hook reference respectively requires them. JSON settings/baselines use JSON.parse; duplicate
JSON member detection is not supplied, so these are reviewed repository metadata,
not authenticated untrusted authority. Malformed JSON and unknown baseline fields
SHALL fail. Automatic source selection SHALL exclude local journals, proof claims,
approvals, operator homes and credentials. An explicitly supplied contained
`--ratchet PATH` is caller-selected baseline data: the checker SHALL validate its
shape and compare its set without authenticating its provenance. CI SHALL bind
the actual base Git bytes separately through REQ-6.

Success SHALL exit0 with empty stderr and exactly one stdout line:
`enforcement: references valid reqs=N tiers=N mechanical=N process=N unenforced=N\n`.
Each N SHALL be a canonical nonnegative decimal integer. Mechanical + process +
unenforced SHALL equal reqs + tiers; each selected key counts exactly once. Refusal SHALL exit1 with empty stdout and fixed-prefix stderr
using `usage|input|structure|reference|ratchet`. Arguments are usage; unsafe or
unreadable selected inputs, encoding, size and directory bounds are input.
Overages of 32 references per annotation or 1024 characters per reference/path
are also input. Malformed Markdown, workflow/settings shape, or baseline JSON/schema
are structure. Malformed reference grammar/normalization, unresolved typed targets
and unsupported hook wiring are reference. Current-baseline
set mismatch and base regression are ratchet. A missing selected workflow/settings
dependency is input; a safely read workflow without the named job is reference.
Diagnostics MAY contain bounded
JSON-escaped selected paths, REQ IDs and line numbers; they SHALL NOT print file
bodies, hook command strings, parser excerpts, supplied argument values or stacks.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs

## REQ-6 — Monotonic mechanical-reference baseline

THE CHECKER SHALL load `governance/enforcement-baseline.json` with exactly
`{"schema_version":1,"enforced":["specs/...md#REQ-X", "docs/SECURITY.md#tier-2"]}`.
The array SHALL contain sorted distinct selected keys. Its set SHALL equal the
current keys whose annotation is a nonempty resolved typed-reference list.
PROCESS and UNENFORCED SHALL NOT count as mechanical entries.

IF a baseline-enforced key is absent from the selected source, becomes PROCESS,
becomes UNENFORCED, or ceases to resolve, THEN THE CHECKER SHALL fail. WHEN comparing
a supplied base baseline, THE CHECKER SHALL additionally refuse removal of any
base enforced key from the current baseline. Replacing one valid mechanism by
another valid mechanism is allowed subject to ordinary review. A rename/deletion
has no automatic exemption; a future retirement/move policy requires its own
explicit spec rather than dropping a key to obtain green.

The required `validate` job SHALL run the default check after the locked install.
For a PR, the existing full-history checkout SHALL supply the Git objects. A
fixed CI preparation step SHALL capture the environment-provided PR base SHA once
as exactly 40 lowercase hexadecimal characters. Through fixed read-only `cat-file`
and `ls-tree -z` argument vectors against that exact commit, it SHALL require the
exact baseline path to be a `100644` blob and read at most 1MiB of its bytes. It
SHALL NOT substitute a mutable ref, evaluate input text, fetch the network, or
silently use a worktree copy. Invalid object type, malformed framing, command
failure, missing objects and oversize data SHALL fail without a fallback.

Only an exact successful tree lookup proving absence at the frozen introduction
base SHA `98648cfc6710a80444943165ab7dcd2c80f86210` SHALL supply the explicit
empty schema1 baseline. This is the merged MR21 closure commit selected by root;
absence at any other base commit SHALL fail. `git show || echo {}` is prohibited. Preparation
SHALL create the contained `.workflow/state/enforcement-base.json` exclusively
without following symlinks or overwriting a prior file, and the checker SHALL
compare that file through `--ratchet`. The checker itself has no Git/network
authority. The exact inline CI source and bootstrap refusal fixtures SHALL receive
source review before implementation; no generic Git-reader abstraction is introduced.

**Enforced by:** test:tests/ci/check-enforcement.test.mjs; test:tests/ci/check-enforcement-baseline.test.mjs; job:.github/workflows/ci.yml#validate

## REQ-7 — Honest annotation migration and delivery

THE MIGRATION SHALL give all scoped REQs and three tier rows an annotation,
including the new checker spec itself. It SHALL use UNENFORCED for incomplete
guarantees rather than laundering partial tests into whole-REQ completion, and
PROCESS only for genuinely procedural/one-time obligations. Informational
mechanism pointers and outstanding clauses MAY remain in separate prose.
It SHALL preserve every existing requirement/AC body and historical observation;
only annotation lines, narrowly necessary explanatory notes and the tier's new
annotation column change. M24 SHALL cite `tests/graph-dashboard/reader.test.mjs`
for observer assertions, retain `tests/graph-dashboard/state-readers.test.mjs` for
read-only guards, and add `tests/graph-dashboard/sprint-doc.test.mjs` for its literal
loopback assertion. Tier1 and tier3 SHALL use whole-row UNENFORCED; tier2 SHALL
cite only its current gitleaks/Semgrep jobs with an explicit planned-column
exclusion and its dated snapshot body preserved. M14, M22 and J8 SHALL retain
the conservative mixed-requirement dispositions in the reviewed migration. M27
SHALL cite the scoped DAST job/tests following actual AMD64 acceptance, while
local-dast REQ-8 remains PROCESS for actual detector-positive observations.

Before implementation, tests SHALL witness the absent feature and be committed
with the narrow spec. Existing tests SHALL remain intact. The delivered source
SHALL pass the focused CLI suite, current-source checker, baseline ratchet and
required candidate checks. A green lint SHALL NOT mark any other roadmap item or
whole masterpiece complete. Independent security review remains required.

**Enforced by:** PROCESS

## Acceptance criteria

1. Current supported Markdown forms select every real REQ; fences/comments/ACs
   do not count. Missing/duplicate IDs/annotations, malformed tables and hidden
   unterminated regions and nested REQ headings refuse; separate level2/level3
   sections and repeated IDs across different files remain valid.
2. Existing named tests and explicit workflow/job references pass. Missing,
   wrong-kind, malformed or redirected targets fail. Workflow expressions remain
   inert. PROCESS/UNENFORCED pass as distinct nonmechanical outcomes.
3. Complete current wrapper fixtures resolve exact event/matcher/path. Unwired
   gitleaks, wrong matcher/event, echoed/commented mentions, changed wrapper text
   and missing hook files refuse. Warning-only hooks remain nonblocking in docs.
4. Baseline enforced→UNENFORCED is nonzero (original AC-M20.1); enforced→PROCESS,
   key deletion, baseline removal and corrupt/missing base data also refuse.
   Additions and valid mechanism substitutions pass. Exact proven initial base
   absence works only at the frozen introduction base SHA; wrong-base absence,
   symlink/existing staging paths and malformed Git output refuse.
5. CLI argument/encoding/size/depth/count/regularity/symlink/hardlink failures are
   private and read-only; sentinel source strings are never executed or disclosed.
6. Source-backed annotation migration covers the complete tree and tier rows.
   Removing an annotation or citing the unwired post-tool gitleaks hook fails;
   tests do not mistake the current honest `nothing automatic` row for a false claim.
7. The required validate job runs both applicable checks; no new hook/settings,
   Workflow, operator data or funded provider is needed. Default success is only
   source-reference integrity with explicit PROCESS/UNENFORCED counts.
