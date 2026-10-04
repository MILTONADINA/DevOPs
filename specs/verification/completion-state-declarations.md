# Optional completion-state declarations

**Spec ID**: verification/completion-state-declarations
**Status**: draft
**Last updated**: 2026-10-03

## Scope and precedence

MR12-A implements only the declared vocabulary in masterpiece REQ-M10. It
does not implement completion-state evidence checks, readiness-document
citation lint or AC-M10.1, and does not complete MR12 or MR10.

The root agent selected this optional schema-only slice under the owner's
standing roadmap-continuation instruction and Decision12's low-risk
validation/CI infrastructure route. That route still requires RED first, the
required checks, an approval record naming the PR/full head SHA and independent
security review. No Workflow, run-record or hook behavior is changed.

MR10-A `claim-schema-loading.md` REQ-3 said not to add undeclared restrictions,
including requiring completion state, without a separate schema/spec change.
This spec supplies a scoped later schema extension only for the shape of
**supplied** `claim.state`. The field remains optional and the original
required-property list is unchanged.
The prior unrestricted acceptance of this additional property is superseded
only by the six-value policy below. MR10-A REQ-4 and MR10-B REQ-10 preservation
remain in force except for rejecting supplied state values that violate the
new declared schema. No existing test assertion granting an arbitrary state
value is known; existing state-less positive fixtures remain valid.

MR10-C1 RED requirements, selection behavior, other schema constraints,
additional-property policy and the existing hash remain unchanged. There is
no historical migration, grandfathering mode, state default or evidence upgrade.

## REQ-1 — Constrain supplied completion-state declarations

WHERE a selected claim contains `claim.state`, THE VALIDATOR SHALL require a
string equal to one of `implemented`, `verified`, `code_converged`,
`release_ready`, `fixed_not_live` or `production_complete` through its packaged
sibling claim schema.

WHEN a selected claim omits `claim.state`, THE VALIDATOR SHALL permit that
absence without deriving or inserting a state.

The property is a direct member of `claim`, not `proof` or the document root.
All ten existing claim types use the same rule. Matching is exact and
case-sensitive; no whitespace trimming, case conversion, hyphen conversion,
coercion or alias is introduced. Unknown strings and nonstrings fail ordinary
schema validation. Unrelated additional properties remain permitted under the
existing schema policy.

**Enforced by:** `verification/claim-schema.yml` and the shared schema loader.
**Falsified by:** an unknown supplied state passes, or a valid state-less claim
starts requiring a new field.

## REQ-2 — Preserve selection, hashing and input values

WHEN any nonempty selection applies the shared claim schema, THE VALIDATOR
SHALL apply REQ-1 to its selected documents.

THE VALIDATOR SHALL preserve existing committed and legacy selection behavior.

THE VALIDATOR SHALL preserve the existing reproducibility-hash formula.

The policy therefore reaches explicit local files, nonempty implicit discovery
and selected committed documents. Committed `--claim` still binds every member
but schema-validates only the selected claim. Implicit-empty discovery still
succeeds without schema loading; explicit committed empty sets still fail.
Generated project hooks inherit the shared schema through their existing
explicit-file call, without hook changes. Parser bounds, schema authority,
diagnostics, RED requirements, declared GREEN exits, Git checks and all-member
publication binding remain intact. No data mutation or additional-property
removal is introduced.

`state` is excluded from the unchanged command/environment/GREEN-SHA hash.
Committed member hashes bind its declared bytes, without proving their truth.

**Enforced by:** the existing shared loader and preserved selection/hash code.
**Falsified by:** state insertion changes the reproducibility hash, bypasses
manifest binding or introduces a new state-dependent selector.

## REQ-3 — Keep vocabulary acceptance separate from evidence

THE VALIDATOR SHALL NOT introduce state-dependent commands, convergence or
work-graph reads, deployment checks, network requests or readiness mutations
in this slice.

WHEN invoked with `--no-rerun`, THE VALIDATOR SHALL retain the existing inert
command boundary and metadata-only acceptance meaning.

THE VALIDATOR SHALL retain its controlled schema diagnostics without printing
the rejected state value or other raw claim contents.

All six valid strings remain declarations. Accepting `code_converged` does not
observe a convergence status; accepting `release_ready` does not check graph
dispositions; accepting `production_complete` does not validate deploy proof.
In particular, a shape-valid production state without deploy evidence can
still pass this slice: the production refusal in AC-M10.1 remains unimplemented.
No synthetic test control is evidence of the corresponding real-world state.

M10's intended ordering and the meaning of `fixed_not_live` remain policy,
not an implemented comparison. This slice assigns no rank to `fixed_not_live`
and never calls it deployed. It adds no deploy-proof shape or substitute for
the owner's later local-first/no-deployment ship goal in ADR-0025. Semantic
guards and their local-first reconciliation require separate contracts.

Legacy raw shell replay remains unsafe and unchanged. MR10 safe replay, RED
provenance/retention and `/sprint` integration remain unfinished work.

**Enforced by:** schema-only behavior change, inert CLI fixtures and current
documentation.
**Falsified by:** a state causes execution or a state-dependent lookup, a
malformed value is dumped into diagnostics, or metadata acceptance is reported
as verified completion.

## REQ-4 — Preserve history and describe the limited policy

THE DOCUMENTATION SHALL describe completion state as an optional constrained
declaration whose evidence is not verified by this slice.

THE IMPLEMENTATION SHALL preserve historical claim bytes and readiness
snapshots rather than adding or upgrading their states to satisfy the schema.

Current consumer changes are limited to `verification/README.md`,
`docs/VERIFICATION.md`, a bounded threat note in `docs/SECURITY.md` and roadmap
row12. No real claim needs a new state. A previously selected claim with a
now-invalid supplied value remains an honest refusal; this spec neither
retargets history nor invents supporting evidence. No historical claim scan or
execution is needed for acceptance.

The roadmap dependency is narrowed only for this vocabulary slice: implemented
MR10-A/B/C1 provide its schema and publication prerequisites. Whole MR10,
semantic M10 guards and readiness-document lint remain open. This does not
declare another roadmap item's complete dependency satisfied by partial work.

**Enforced by:** current consumer review and preservation of historical inputs.
**Falsified by:** state-less history is rewritten, the roadmap marks all of
MR10/MR12 complete, or a claim author is told to add an unsupported state.

## Acceptance criteria

### AC-1 (REQ-1)

Owned explicit-file CLI fixtures accept absence and each of the six exact
strings on otherwise valid claims. Fixtures reject an unknown string, empty
string, wrong case, hyphenated variant, surrounding whitespace, trailing
newline, null, boolean, number, array and object. A valid supplied state does
not remove existing required fields or RED obligations.

### AC-2 (REQ-1, REQ-2)

Owned selected committed fixtures demonstrate the same absence/valid/invalid
state behavior under both `--all --no-rerun` and
`--claim <id> --no-rerun`. Nonempty implicit local discovery rejects an invalid
supplied state. Existing empty-mode, all-member binding and selected-only
schema assertions remain intact. Keep current state-less default fixtures;
do not rewrite every fixture to conceal a new required-field dependency.

### AC-3 (REQ-1, REQ-2)

The policy is not conditional on claim type: the existing ten types retain
state omission and reject a malformed supplied state with other required data
provided. Changing only between absent and valid state leaves the declared
reproducibility hash unchanged. Existing inclusive description280, nonzero
GREEN exit, extra-property and C1 RED assertions remain preserved.

### AC-4 (REQ-2, REQ-3)

Owned fixtures retain the no-write/no-command sentinel checks and controlled
diagnostics. A rejected-state sentinel is not printed. Valid state values
cause no additional Git or external evidence calls compared with the same
state-less selection. Convergence/graph/deploy fixtures are unnecessary:
absence of those mechanisms does not prevent valid enum metadata acceptance
and is never reported as semantic verification.

### AC-5 (REQ-4)

Current documentation states optionality, the exact vocabulary, unchanged
hash and unimplemented semantic guards. The dedicated spec remains draft;
MR10/MR12 completion and AC-M10.1 are not claimed. No historical claims,
readiness snapshots, Workflow scripts, hooks or unrelated schema constraints
change to make the new acceptance tests pass.
