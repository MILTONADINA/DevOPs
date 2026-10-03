# Validate an exact committed proof set

**Status**: draft

**Scope:** MR10-B, the committed selection and provenance portion of
masterpiece REQ-M9 under the owner's roadmap continuation and Decision 3.
This extends MR10-A without approving the whole masterpiece draft. It makes
CI validate a real nonempty set of committed declarations. It does not
observe historical command execution, implement RED replay or finish the
future /sprint claim interface.

This spec supersedes claim-schema-loading.md REQ-4's empty-selection clause
and AC-5 **only for explicit --all selection**. The existing explicit-file
mode and implicit local discovery remain compatibility paths. Their older
Git/file/hash/default shell replay behavior is not the committed CI gate.
Acceptance never enables raw replay or reads historical local proof data.

## REQ-1 — Select one finite committed manifest

WHEN committed validation is requested, THE VALIDATOR SHALL select only
.workflow/proofs/committed/manifest.json within the canonical calling project.
No environment variable, claim member, alternate directory or CLI path SHALL
replace this selector. It SHALL parse one strict UTF-8 JSON value with exactly
the keys schema_version, claims and artifacts; schema_version SHALL be 1.

Each claims entry SHALL contain exactly id, path and sha256. The ID SHALL
match the packaged claim-ID grammar, the path SHALL be claims/<id>.yml, and
the hash SHALL be 64 lowercase hexadecimal SHA-256 characters. Each artifacts
entry SHALL contain exactly path and sha256. Artifact paths SHALL be under
scripts/ or _checks/. Both arrays SHALL contain 1–100 entries. IDs and member
paths SHALL be unique; all paths SHALL be relative to the committed directory.

Paths SHALL use normalized relative POSIX spelling, with no absolute form,
empty/dot/dotdot component, backslash, control character or log suffix. No
member SHALL be a directory, symlink, gitlink or the manifest itself. The
manifest SHALL be at most 65536 bytes and members at most 262144 bytes each,
inclusive. Working reads SHALL retain MR10-A's bounded regular-file,
strict-UTF-8 and no-redirect policy. JSON object duplicate-member last-value
semantics remain a stated parser limitation; duplicate array entries are
rejected. This is an exact byte selector, not author authentication.

**Enforced by:** committed input selection and owned CLI fixtures.
**Falsified by:** an empty or alternate set is accepted, or an unlisted local
historical claim is discovered by this mode.

## REQ-2 — Bind publication bytes to captured HEAD

WHEN a manifest is selected, THE VALIDATOR SHALL require the manifest and
every named member to be regular 100644 or 100755 blobs in one captured HEAD
commit. Working bytes SHALL equal those committed blobs, and each member's
bytes SHALL match its declared hash. An untracked or staged-only artifact
SHALL NOT count as committed evidence. The manifest does not hash itself.

THE VALIDATOR SHALL list only the dedicated committed subtree in that HEAD
tree and refuse any unlisted tracked entry. It SHALL NOT inspect ignored
local proof history or add untracked extras to the set. All named members
SHALL be bound even when --claim selects only one claim; only the selected
claim's schema and provenance checks may then be narrowed. Artifacts are
committed declarations: the manifest does not prove that command text refers
to or executed them.

**Enforced by:** captured-tree/blob comparisons and manifest digests.
**Falsified by:** staged-only or changed working bytes satisfy the committed
gate, or a bad unselected member binding is ignored by --claim.

## REQ-3 — Make committed selectors read-only and unambiguous

WHEN called with --all --no-rerun, THE VALIDATOR SHALL validate every selected
claim. WHEN called with --claim <id> --no-rerun, it SHALL validate the named
member after binding the complete manifest set. Missing/empty sets and an
unknown ID SHALL fail. Conflicting or repeated selectors, a missing ID,
extra positional arguments and unsupported flags in committed mode SHALL
fail before any replay. A committed selector without --no-rerun SHALL fail
usage; it SHALL never enter the legacy shell path.

Exact --all/--claim tokens and their attached-value forms (--all=... and
--claim=...) SHALL be recognized before compatibility dispatch. Attached-value
forms SHALL fail usage instead of falling through to implicit local discovery.
Only one --no-rerun token is allowed in committed mode. It may precede or
follow --all, or precede the --claim <id> pair or follow that pair; the ID
must immediately follow --claim. No other committed argv shape is supported.

The packaged sibling schema remains authoritative. Each selected document
SHALL satisfy that actual schema without mutation, and its claim.id SHALL
equal the manifest ID. The existing reproducibility-hash formula SHALL be
retained. Committed success SHALL be described as acceptance of committed
claim metadata, never as independently verified GREEN, RED or command output.

Existing explicit-file invocation remains a separate compatibility mode;
implicit local discovery retains its old empty result. Neither mode can
satisfy the committed CI gate. This slice SHALL NOT execute a selected
command, create a rerun file, install tools or repair the repository.

**Enforced by:** CLI selection before legacy dispatch and safe output.
**Falsified by:** --all succeeds on an empty committed set, missing --claim
IDs succeed, or a selected declaration executes a command.

## REQ-4 — Admit a contained ordinary Git store

BEFORE invoking Git for committed validation, THE VALIDATOR SHALL require
an ordinary nonsymlink .git directory directly under canonical CWD. Gitfiles,
linked/shared worktrees, bare repositories, SHA-256/reftable stores, shallow
and partial/promisor stores are outside this initial supported layout and
SHALL fail. There SHALL be no ancestor search or caller-supplied repo root.

Metadata admission SHALL reject redirects, special entries, shared hard-link
files and inspection errors in consumed metadata. It SHALL perform bounded
lstat-only enumeration of refs/ and objects/ (at most 100000 entries and
depth 16), without scanning or decompressing historical object contents.
It SHALL refuse commondir, gitdir, worktrees, config.worktree, reftable,
shallow, info/grafts, object alternates/http-alternates and promisor markers.
HEAD and loose ref text SHALL be bounded to 65536 bytes; symbolic references
SHALL stay within normalized refs/ names. Packed refs SHALL be at most 8 MiB.
Permission errors SHALL NOT be interpreted as absent metadata.

Local config SHALL be at most 65536 bytes and read as bounded project data
before Git can follow includes. The supported envelope is blank/comment lines, ordinary single-line
section headers with optional literal quoted subsections, and ordinary keys
with optional single-line values. Continuations, escaped/ambiguous headers,
NUL or keys outside a section SHALL fail. Section and key recognition SHALL
be case-insensitive, including old dotted subsection spelling. All include,
includeIf and extensions sections, core.worktree, core.alternateRefsCommand,
remote promisor/partialCloneFilter keys, nonzero repositoryFormatVersion and
core.bare values other than false SHALL fail. Missing format/bare keys use
Git's ordinary version-0/non-bare defaults. Config values SHALL NOT be printed.

These are finite supported-layout checks. They SHALL NOT be described as an
atomic filesystem sandbox, executable authentication or protection against
every hostile Git configuration, corrupt object or same-user replacement race.

**Enforced by:** local metadata admission before any Git subprocess.
**Falsified by:** an external store/config redirect or lazy fetch is accepted,
or an unsupported layout is automatically repaired instead of refused.

## REQ-5 — Use captured Git authority and bounded plumbing

THE VALIDATOR SHALL use argv arrays, fixed Git/work-tree paths and a minimal
environment. Inherited Git routing/config, shell startup, preload, tracing,
pager and askpass variables SHALL NOT select behavior. System/global config,
replacement objects, lazy fetching, transports, hooks, fsmonitor, external
diff/textconv and optional writes SHALL be disabled. Installed Git and its
normal runtime remain trusted prerequisites. No Git subprocess SHALL fetch,
check out, mutate refs/config/index or request credentials.

THE VALIDATOR SHALL capture HEAD and refs/remotes/origin/main once as full
40-hex commit IDs and use those immutable IDs for later operations. The latter
is a CI-prepared local ancestry authority, not authenticated remote freshness.
A claim's proof.git_sha SHALL be a full 40-hex commit ID and an ancestor of
that captured main commit. Missing objects, missing main and non-ancestors
SHALL fail; mere object existence is insufficient.

Git commands SHALL time out after 5 seconds. Small metadata responses SHALL
be bounded to 64 KiB, tree/change listings to 1 MiB and blobs to their input
cap plus one byte. Timeout, signal, overflow, malformed framing or unexpected
exit status SHALL fail without exposing raw output. No broader retry or fetch
fallback is permitted. Blob kind and size SHALL be checked before content.

**Enforced by:** one bounded read-only Git interface and snapshot IDs.
**Falsified by:** an orphan object passes ancestry, inherited routing selects
another repository, or a moved ref substitutes evidence after capture.

## REQ-6 — Verify changed regular blobs and target-spec anchors

FOR each selected claim, THE VALIDATOR SHALL require every files_changed path
to be normalized and present in the target commit's first-parent changed-file
set, with rename detection disabled. A root commit compares against the empty
tree. Each name SHALL also resolve to a regular 100644/100755 blob at that
target. Deleted names, directories, symlinks and gitlinks SHALL fail. Paths
SHALL use literal Git treatment, never revision-expression or pathspec syntax.

The committed-mode spec_ref SHALL contain one normalized specs/ Markdown path
and one nonempty fragment. The referenced file SHALL be a regular bounded
UTF-8 blob of at most 262144 bytes in that same target commit; a newer working
copy SHALL NOT supply missing evidence. This checks existence, not approved
status or REQ/AC coverage.

Supported anchors SHALL be defined as follows:

- ATX headings start with at most three spaces, 1–6 hash signs and a space or
  tab. Optional closing hashes preceded by whitespace are removed.
- Heading text is trimmed, lowercased and stripped of characters other than
  ASCII letters, digits, space, tab, underscore and hyphen. Each remaining
  space or tab becomes one hyphen; repeated hyphens are not collapsed. Thus
  the em dash in MR10-A's REQ-4 title is removed, leaving its two surrounding
  spaces as two hyphens. Empty resulting slugs are ignored.
- Standalone literal <a id="TOKEN"></a> lines, with at most three leading
  spaces and TOKEN matching [A-Za-z][A-Za-z0-9_-]*, supply case-sensitive IDs.
  No other HTML or renderer-specific anchor syntax is inferred.
- Both forms are ignored inside fenced code. A fence starts with at most
  three spaces and at least three identical backticks or tildes; a closing
  fence uses the same character with at least the opening count and only
  trailing whitespace. An unclosed fence extends to EOF.
- The fragment is matched literally without URL decoding. More than one
  supported occurrence of the requested anchor is ambiguous and SHALL fail;
  numeric duplicate-heading suffixes are not synthesized.

This is a finite anchor rule, not a complete Markdown renderer.

**Enforced by:** target-tree/blob reads and finite anchor extraction.
**Falsified by:** a deleted file, orphan target, missing target spec/anchor or
working-only replacement spec passes.

## REQ-7 — Preserve diagnostic privacy and inert declarations

IF any committed input, Git or policy check fails, THE VALIDATOR SHALL return
nonzero with a fixed category and a validated ID only when safe. It SHALL NOT
echo input filenames, arbitrary property names, command/environment contents,
config values, raw Git output or exception stacks. Schema diagnostics retain
MR10-A's escaped schema-path/keyword projection. Metadata success SHALL NOT
be presented as authentication, review approval or observed execution.

**Enforced by:** controlled diagnostics and synthetic sentinels.
**Falsified by:** a malformed input leaks a sentinel or causes shell execution.

## REQ-8 — Publish a truthful documentation seed

THE FIRST committed set SHALL contain a new type doc claim about the
verification README disclosures at merged MR10-A commit
daa1250309c770f322d73d872af3d83b42bd7d24. It SHALL assert only the documented
distinction between --no-rerun metadata checks and unsafe default replay;
it SHALL NOT relabel implementation or test success to avoid RED evidence.

The selected YAML, reviewed proof script and JSON _checks/ file SHALL be
committed; the captured log SHALL remain ignored. The known script SHALL be
invoked directly once against that target's README blob after its bytes and
checks freeze, with an owned negative control proving its text assertion.
The claim SHALL record the actual target, command and observed exit, and bind
script/check hashes in its declared proof environment. The publication manifest
binds those files at the later publication HEAD; the script need not have
existed at the older documentation target. This is a named blob-content proof,
not a worktree replay at that historical SHA.

CI SHALL validate declared metadata and committed bytes without requiring the
uncommitted log. Implementation/test proof.red and safe code-versus-script
replay remain separate MR10 work; no historical RED shall be invented.

**Enforced by:** reviewed seed, direct owned proof observation and publication.
**Falsified by:** an implementation result is presented as a doc-only claim,
or CI metadata validation is claimed to observe an uncommitted test log.

## REQ-9 — Migrate live consumers explicitly

WHEN generating a project pre-commit hook, init-project.sh SHALL pass an
explicit quoted Bash array of top-level local .yml filenames with --no-rerun,
instead of --all. The array SHALL use nullglob and dotglob, contain no
recursive members, skip invocation when empty and propagate validator failure.
This explicitly includes hidden-only local YAML, which the former outer glob
guard could skip. Existing gitleaks and tool-availability behavior stays intact.
The hook SHALL be documented as a local compatibility check, not the
committed CI gate; consuming projects need no fabricated seed to commit.

Active verify-claims, emit-claim and launch-readiness command documentation,
their catalog, devops verify help and current verification/playbook docs SHALL
describe the selectors consistently. Emission validates the just-emitted
explicit files with --no-rerun; committed verification uses --all or --claim
with --no-rerun. No historical dashboard, recovery script, root .githooks
policy, skill or unrelated command implementation SHALL be rewritten.

**Enforced by:** generated-hook argv/failure fixtures and current consumer docs.
**Falsified by:** the first local claim makes a fresh consumer require the
DevOPs committed set, filenames split in argv, or hook failure is swallowed.

## REQ-10 — Activate nonempty CI atomically

THE SAME candidate that changes --all SHALL publish the complete seed set,
reopen only its intended paths in .gitignore and keep all logs and ordinary
local proof children ignored. No broad force-add or historical proof migration
is permitted. The committed-set gate SHALL run against the committed candidate,
not staged-only publication data.

The required validate job SHALL check out full history, remove depth-1
restrictions from its later baseline fetches, and explicitly prepare the fixed
origin/main ref without a depth restriction before --all --no-rerun. It SHALL
remove the separate legacy stale-detector step, because the selected-set
ancestry gate now validates the exact same set more strongly. Other jobs,
required context names and scanner/model-review policy SHALL remain unchanged.

MR10-A's two empty-selection controls SHALL be amended explicitly under this
new contract; their old --all success SHALL NOT be silently retained. Legacy
implicit empty discovery may retain its own positive controls. All other
MR10-A assertions SHALL be preserved. Whole REQ-M9 and AC-M9.2 remain pending.

**Enforced by:** the committed publication, ignore rules and CI integration.
**Falsified by:** CI accepts an empty set, lacks target ancestry history or
still runs a different local-history selector as a second evidence gate.

## Acceptance criteria

### AC-1 (REQ-1, REQ-2, REQ-3)

Owned CLI fixtures SHALL show a valid committed set accepted in both selectors,
all member bindings checked for --claim, and refusal of absent/empty sets,
missing IDs, duplicate/conflicting selectors, replay-enabled selection,
malformed manifests, ID/hash mismatches, untracked/staged/changed members and
unlisted tracked entries. Ignored unselected local data SHALL stay unread.

### AC-2 (REQ-4, REQ-5)

Owned ordinary Git fixtures SHALL distinguish ancestors from stored orphans,
missing main/objects and shallow/promisor stores; exercise contained packed
and loose storage, inherited routing, config includes, metadata redirects,
alternates/grafts/replacements and changed refs after capture. No fixture
SHALL depend on an ancestor repository or actual operator configuration.
Malformed/oversized output and failed Git prerequisites SHALL not count as
the intended behavior failure in witnessed RED.

### AC-3 (REQ-6, REQ-7)

Fixtures SHALL cover root and first-parent merge changes, deleted and
nonregular entries, target-snapshot specs, missing/duplicate/fenced anchors,
the specified em-dash slug, literal IDs and safe diagnostics. A synthetic
command/sensitive value SHALL remain inert and absent from failure output.

### AC-4 (REQ-8, REQ-9)

The reviewed documentation proof SHALL pass at the real merged target and
reject an owned altered-content control. Generated hooks SHALL preserve empty
skip, quoted paths, hidden YAML inclusion and nonzero propagation without
running the real installer, gitleaks, validator corpus or provider calls.

### AC-5 (REQ-10)

The final committed candidate SHALL validate its real named set read-only;
ignore checks SHALL distinguish intended tracked members from logs/local
state. Required CI SHALL validate that nonempty set with full ancestry and
the preserved context names. No model skip SHALL be reported as a performed
review, and no metadata result as observed RED/GREEN execution.

Focused tests SHALL use existing .test.mjs discovery, locked local tools and
fresh owned fixtures. Parent execution remains serialized: source/prerequisites
first, meaningful witnessed and committed RED, implementation, focused GREEN,
then the required full and delivery gates. No historical local proof audit,
real Workflow journal, live model/provider, database or paid service is needed.
