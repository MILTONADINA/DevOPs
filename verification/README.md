# Verification

The proof-of-work enforcement layer.

## Files

- `claim-schema.yml` — the structure every proof artifact must satisfy
- `claim-validator.ts` — validates the packaged schema, checks Git metadata and hashes, and optionally re-runs declared commands
- `confidence-rules.yml` — when a claim should be downgraded to medium/low
- `reproducibility-check.ts` — helper to compute reproducibility_hash before emitting a claim
- `stale-proof-detector.ts` — finds proofs whose Git commit is absent from the local object store

## Usage

```bash
# Validate a single claim without executing its command
npm run validate:claims -- .workflow/proofs/claim-2026-05-22-018.yml --no-rerun

# Validate the complete committed manifest set
npm run validate:claims -- --all --no-rerun

# Validate one committed claim after binding every manifest member
npm run validate:claims -- --claim claim-2026-10-03-019 --no-rerun

# Find stale proofs
npx tsx verification/stale-proof-detector.ts

# Generate the hash for a new claim before writing it (no environment block)
npx tsx verification/reproducibility-check.ts 7c4a9f2 "pnpm test auth/token"
```

The committed selectors require `--no-rerun`; omitting it fails usage. In
legacy explicit-file or implicit local-discovery mode only, omission retains
the existing behavior: the validator executes
claim-controlled shell text with the caller's environment and may write a
`.rerun` file. That replay path is not a safe execution boundary. A successful
`--no-rerun` result accepts declared data and metadata; it does not establish
that the declared command, GREEN or RED was observed.

## Packaged schema validation (MR10-A)

The validator loads the fixed sibling `claim-schema.yml` from its own package,
even when called from another project. A schema in the calling project does
not override it. Claim paths must stay within the canonical working directory;
the schema stays within the validator's package root. Inputs must be regular
files without symlink components, at most256 KiB each, and valid UTF-8.

Both inputs use one YAML1.2 core document with string mapping keys and finite
JSON-compatible values. Duplicate keys, anchors, aliases, nonstandard tags,
multiple documents and collection nesting above64 levels are refused.
Standard quoted, literal and folded string values retain their YAML semantics.
The draft2020-12 schema compiles offline with local fragment references and
`date-time` validation. Validation does not coerce types, insert defaults or
remove properties. New failures use fixed input categories or escaped schema
paths and keywords without printing claim contents.

This is the schema-loading slice of
[MR10](../specs/verification/claim-schema-loading.md). The legacy explicit-file and implicit-discovery Git checks
establish commit-object existence and whether each claimed filename appears in
the commit's changed-file list; they do not prove reachability or regular-file
existence at that commit. The hash is recomputed from declared command,
environment and SHA strings. The schema permits additional properties and
nonzero integer declared GREEN exits. The conditional RED rule below adds
shape validation without changing that hash or the older Git checks.
Safe RED execution, RED provenance and `/sprint` integration remain pending.
The metadata checks here do not complete all of MR10.

## RED declarations (MR10-C1)

The shared schema requires `proof.red` for `implementation` and `test` claims.
For the other eight claim types it is optional; any supplied RED object must
still be valid. It contains `sha`, exactly 40 lowercase hexadecimal characters,
and `exit_code`, a nonzero integer. Negative integers and integers above 255
are accepted declarations; no shell exit-code range is inferred. Extra
properties remain permitted. See [the declaration contract](../specs/verification/red-declarations.md).

This policy applies to selected local and committed documents, including
explicit files passed by generated project hooks. Authors must record an
actually observed earlier failure; missing evidence must not be invented or
an implementation relabeled as documentation to pass validation.

The validator does not look up the RED SHA, establish its existence or
ancestry, or observe a failed command. The unchanged reproducibility hash
excludes `red.sha` and `red.exit_code`. A committed member digest binds these
bytes as declarations, not evidence that an execution happened. Safe replay
and durable RED retention need separate work.

## Optional completion-state declarations (MR12-A)

A supplied `claim.state` must be one of `implemented`, `verified`,
`code_converged`, `release_ready`, `fixed_not_live` or `production_complete`.
The field is optional for all claim types; absence supplies no default state.
Matching is exact, with no case conversion or whitespace trimming. See the
[state declaration contract](../specs/verification/completion-state-declarations.md).

This validates vocabulary only. Convergence, graph-disposition and deployment
checks are not implemented, and acceptance of `production_complete` without
those checks does not satisfy AC-M10.1. `fixed_not_live` is not called deployed.
Authors need evidence for a declared state; schema acceptance supplies none.
The reproducibility hash excludes state, while committed member hashes bind
its declared bytes. Existing claims need no state backfill or evidence upgrade.
Whole MR12 and MR10 remain open; legacy raw replay remains unsafe.

## Committed metadata validation (MR10-B)

`--all --no-rerun` selects exactly
`.workflow/proofs/committed/manifest.json`. `--claim <id> --no-rerun` selects
one claim after checking the bindings of every manifest member. Both refuse
a missing/empty set, unknown IDs, conflicting flags or replay-enabled usage;
neither falls back to local proof discovery.

The manifest names committed claim YAML and reviewed scripts/checks, with
SHA-256 hashes. It and every listed member must be regular blobs at captured
HEAD with identical working bytes; an unlisted tracked entry in the dedicated
subtree fails. Untracked or staged-only publication is insufficient. Logs and
ordinary local proof history stay ignored and are not selected.

Each selected claim must pass the packaged schema, match its manifest ID and
retain the declared reproducibility hash. Its full commit ID must be an
ancestor of captured `refs/remotes/origin/main`. Changed paths must occur in
the target's first-parent difference and remain regular blobs there. The
referenced spec and its unique supported fragment must exist in that same
target snapshot. The supported ordinary Git layout requires full local
history without shared/redirected, shallow or partial stores; the checker
never fetches or repairs it. See the [finite contract](../specs/verification/committed-claims.md).

Success accepts committed metadata. It does not authenticate the local main
ref, observe an ignored log, execute a command, or prove that command text uses
the named scripts/checks. A project's first committed set requires separately
reviewed YAML, artifacts, manifest and a publication commit; local emission
alone does not create it.

## Closure references (MR18-A)

```bash
# Check the two named documents from captured HEAD
npx --no-install tsx scripts/lint-closures.mjs

# Explicitly substitute the named local polish backlog
npx --no-install tsx scripts/lint-closures.mjs --local-backlog
```

The lint derives its repository root from the script, independently of CWD.
Default mode requires committed `SHIP_BLOCKERS.md` and checks committed
`.workflow/state/polish-backlog.md` if present. The flag takes no path and
requires that exact local backlog; it does not also count the committed copy.
Default mode does not read the ignored local backlog or discover old claims.

Both modes validate the entire nonempty committed proof publication with the
existing metadata checks. Document blobs and proof membership share one
captured HEAD/main context; changing a worktree document does not change the
default result. Local backlog selection is the one explicit exception for
document bytes, never for claim membership. No declared command is executed.

The [closure contract](../specs/graph/closure-references.md) supports two forms:

- A level2/3 heading-owned item with the exact line `**Status:** CLOSED` and one
  `**Closure evidence:** VALUE` line owned by that same heading.
- A three-column `Item | Status | Evidence` table, with a delimiter row and
  outer pipes; a `CLOSED` status cell selects that row.

VALUE is exactly `commit:<sha>; claim:<id>` or `pr:<number>; claim:<id>`.
Replace those placeholders with a 40-character lowercase hexadecimal commit
SHA or canonical positive PR number of at most10 digits, and a full published
`claim-YYYY-MM-DD-NNN` ID. These are format templates, not closure evidence.
The lint checks citation syntax and validated membership; it does not resolve
the cited PR/commit or prove that either the change or claim closes the item.

Evidence cannot be borrowed from another heading/row. An open parent may
contain a closed child; two closed ancestor/descendant items are ambiguous.
Other standalone `CLOSED` occurrences outside fenced examples and standalone
HTML-comment blocks refuse, including unsupported prose/list forms. Mixed
text/comment lines, unclosed comments/fences and comment-synthesized literals
also refuse. Unrelated open items and historical `resolved` prose are untouched.

Selected documents are bounded to256KiB of strict UTF8, physical lines to16384
characters and closed items to1024 total. Success prints
`closures: references valid documents=N closed=N` and exits0. Refusal exits1
with a fixed `closures:` category (`usage`, `input`, `structure`, `publication`
or `reference`) without printing source text or identifiers.

As of2026-10-04, the current ship-blocker document selects zero CLOSED items.
Zero is a valid reported count only with a valid nonempty proof set; it does
not verify historical closures. This lint does not replace the separate
committed metadata gate, change freshness dates or complete MR18/MR10. The
freshness hook remains unchanged and its remaining M21 obligation stays open.

## Integration points

- Session-end hook (`write-baton.sh`) counts the claim files in `.workflow/proofs/`
  that are newer than the previous baton.
- CI (`.github/workflows/ci.yml`) prepares full history and the fixed main ref,
  then runs `claim-validator.ts --all --no-rerun` against the committed nonempty
  set. The legacy stale detector is no longer a second CI gate.
- The generated consuming-project pre-commit hook validates explicit top-level
  local `.yml` files with `--no-rerun`, including hidden names, without recursing
  into the committed set. It skips an empty list and retains its existing
  optional-tool behavior. This compatibility check does not require a manifest
  and cannot substitute for committed CI validation.
- Implicit local discovery still permits an empty result. The standalone stale
  detector still checks local object existence only; it does not use the
  committed selector or prove ancestry.

## How a claim is born

1. Agent completes a verifiable task.
2. Agent emits `.workflow/proofs/claim-YYYY-MM-DD-NNN.yml` matching the schema.
3. `proof-of-work` skill captures stdout+stderr to `.workflow/proofs/<id>-test.log`.
4. Validator checks the declared schema, Git metadata and reproducibility hash;
   command execution is separate from `--no-rerun` validation.
5. Session-summary aggregates verified claims.
6. The stale-proof detector reports claims whose `git_sha` is missing from the local
   object store (`git rev-parse --verify`). A commit that is stored but unreachable
   from any ref still passes.
