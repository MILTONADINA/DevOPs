# Require RED declarations for implementation and test claims

**Status**: draft

**Scope:** MR10-C1 under the owner's continuation of masterpiece
REQ-M9. This implements only its conditional `proof.red` shape requirement
and the missing-RED half of AC-M9.2. It does not approve the whole masterpiece
draft or establish that a RED execution happened.

## Scope and precedence

The agent selected this schema-only slice under the owner's standing
roadmap-continuation instruction. No RED object-existence or
ancestry check is introduced. Squash publication can leave an actual earlier
test commit outside the merged history; durable retention and execution
semantics require a separate design. This slice neither retargets historical
claims nor invents missing evidence to make them pass.

The following earlier preservation statements are superseded only for the
new conditional RED shape policy:

- `claim-schema-loading.md` REQ-3's exclusion of adding `proof.red`, and
  AC-2's positive allowance for an implementation claim without it.
- `claim-schema-loading.md` REQ-4's preservation of validation behavior, only
  to the extent that the newly declared schema rejects these shapes before
  reaching the preserved Git/hash/replay code.
- `committed-claims.md` REQ-10's requirement to preserve every other MR10-A
  assertion, only for the now-obsolete no-RED positive assertion. Its
  nonempty publication, selector, Git and all-member binding rules remain.

The older schema restrictions and compatibility behaviors remain in force:
outer `proof.git_sha` keeps its existing 7–40 lowercase-hex schema shape;
the stronger MR10-B committed-mode rule is unchanged. Declared GREEN
`proof.test_exit_code` remains any integer. Additional properties remain
permitted at the existing object levels. Safe replay, RED provenance,
`/sprint` integration and the execution half of AC-M9.2 remain open.

## REQ-1 — Require the declaration for the two named types

WHEN a selected claim has type `implementation` or `test`, THE VALIDATOR
SHALL require `proof.red` through the packaged sibling claim schema.

WHEN a selected claim has type `scan`, `deploy`, `migration`, `refactor`,
`perf`, `doc`, `security-review` or `threat-model`, THE VALIDATOR SHALL permit
`proof.red` to be absent.

**Enforced by:** the shared claim schema's conditional requirement.
**Falsified by:** a selected implementation/test claim without RED passes,
or an otherwise valid claim of another existing type requires RED.

## REQ-2 — Validate every supplied RED object

WHERE a selected claim contains `proof.red`, THE VALIDATOR SHALL require it
to be an object containing `sha` and `exit_code`.

THE SCHEMA SHALL require `proof.red.sha` to be a string of exactly 40
lowercase hexadecimal characters using a hexadecimal pattern plus both
minimum and maximum length 40.

THE SCHEMA SHALL require `proof.red.exit_code` to be an integer unequal to 0.

THE SCHEMA SHALL permit additional properties inside `proof.red`.

These rules apply to supplied RED objects for all 10 current claim types.
Negative integers and integers above 255 remain valid declarations under
REQ-M9's literal nonzero constraint. No shell exit-code range is inferred.
`0` and numeric negative zero are both zero and fail. Strings and booleans
are not coerced to integers.

**Enforced by:** ordinary offline schema validation before downstream checks.
**Falsified by:** a supplied malformed RED is ignored for a doc claim, a SHA
with a trailing newline passes, or a zero/string/fractional exit is accepted.

## REQ-3 — Apply shared policy without changing selection or hashing

WHEN any nonempty selection loads the shared schema, THE VALIDATOR SHALL
apply REQ-1 and REQ-2 to the documents selected for schema validation.

THE VALIDATOR SHALL retain the existing committed selection and complete
manifest byte-binding behavior.

THE VALIDATOR SHALL retain the existing legacy explicit-file and implicit
discovery selection behavior.

THE VALIDATOR SHALL retain the existing reproducibility-hash formula.

This affects legacy explicit files, nonempty implicit discovery and selected
committed claims. Generated local hooks inherit the policy through their
existing explicit-file call. Committed `--claim` continues to bind all members
but schema-validates only the selected claim. Implicit empty discovery still
skips schema loading and succeeds; explicit empty committed sets still fail.
No defaulting, mutation, type coercion or new additional-property restriction
is introduced. No schema version switch, optional bypass or historical
grandfathering selector is added.

**Enforced by:** the existing shared loader and preserved selection/hash code.
**Falsified by:** the policy applies only in CI, an empty implicit selection
starts requiring a schema, or adding RED changes the existing hash formula.

## REQ-4 — Keep RED acceptance limited to declarations

THE VALIDATOR SHALL NOT add Git object, ancestry, content or reference reads
based on `proof.red.sha` in this slice.

WHEN invoked with `--no-rerun`, THE VALIDATOR SHALL leave declared commands
inert under the existing boundary.

THE VALIDATOR SHALL retain controlled schema diagnostics without printing
RED values, command/environment contents or raw parser errors.

THE DOCUMENTATION SHALL describe this policy as validation of declared RED
shape rather than observation of a RED execution.

An accepted RED SHA need not identify an object available in the calling
repository. Acceptance does not establish that a command ran, failed for the
intended assertion, used the same artifacts/environment, or preceded a fix.
The unchanged reproducibility hash excludes `red.sha` and `red.exit_code`.
Committed member hashes bind their declared bytes but do not authenticate an
execution. Legacy raw shell replay remains unsafe and outside this slice;
its source is preserved, and acceptance never invokes it.

**Enforced by:** schema-only product delta, inert CLI fixtures and accurate docs.
**Falsified by:** a synthetic RED SHA causes new Git lookup, a command executes
during acceptance, or a shape-valid declaration is reported as observed RED.

## REQ-5 — Update current guidance without manufacturing history

WHEN documenting claim creation, THE DOCUMENTATION SHALL require an
implementation/test author to record an actually observed RED SHA and nonzero
exit without inventing missing evidence or retargeting an old claim.

THE DOCUMENTATION SHALL distinguish that author obligation from the
validator's schema-only check.

The narrow current consumer changes are `verification/README.md`'s obsolete
implementation-without-RED allowance; `docs/VERIFICATION.md`'s conditional
required fields; the implementation example and emission instructions in
`slash-commands/universal/emit-claim.md`; a bounded threat note in
`docs/SECURITY.md`; and the MR10 roadmap row. The emission example names a
placeholder for the actual earlier observation rather than suggesting a
synthetic value for real use. Guidance records that the legacy hash excludes
RED fields and that safe execution/durable RED retention remain open.
No historical claim, old proof command, skill or existing committed doc seed
is rewritten to accommodate this schema change.

**Enforced by:** current consumer review and preservation of historical inputs.
**Falsified by:** guidance relabels implementation as doc to bypass RED,
instructs an author to change old evidence, or claims execution was verified.

## Acceptance criteria

### AC-1 (REQ-1, REQ-2)

Owned CLI fixtures reject missing RED for each of implementation and test.
They accept each with a valid declaration. All eight other current types
accept absence and a valid supplied declaration; malformed supplied RED
fails for those types too.

### AC-2 (REQ-2)

Fixtures reject null, array and nonobject RED; either missing required member;
SHA nonstrings, lengths 39/41, uppercase/nonhex characters, whitespace and a
trailing newline; exit zero, negative zero, noninteger numbers, strings,
booleans and null. Positive controls include exactly 40 lowercase hex,
positive/negative nonzero integers and an integer above 255. Extra properties
inside RED and at previously permitted outer levels remain accepted.

### AC-3 (REQ-3)

Explicit-file and nonempty implicit-discovery fixtures enforce the policy.
Committed `--all` and `--claim` enforce it on their selected documents with
publication bindings satisfied. Existing implicit-empty and committed-empty
outcomes remain. The prior maxLength 280/nonzero declared GREEN exit/extra
data positive remains with valid synthetic RED; the old no-RED assertion is
replaced explicitly. The current reproducibility hash remains unchanged.

### AC-4 (REQ-4)

A valid synthetic RED SHA with no repository object passes shape validation
when all existing claim checks pass. Owned Git instrumentation proves the RED
SHA is not used for a new lookup. Command and sensitive-value sentinels remain
inert and absent from refusal output. A second valid RED declaration does not
change the existing reproducibility hash. Metadata output makes no observed
RED/GREEN assertion.

### AC-5 (REQ-5)

Current docs enumerate the conditional RED rule and its limited assurance.
The implementation emission example supplies the actual-observation fields.
No historical input or existing doc-seed bytes change for this work. Whole
MR10 and the execution half of AC-M9.2 remain unfinished.

## Test prerequisites and fixture migration plan

This is a source-derived plan, not a test result or permission to execute.

| Surface | Source prerequisite / required transition | Preservation evidence |
| --- | --- | --- |
| `tests/verification/claim-schema-loading.test.mjs` | Its factory at line 63 deliberately uses type implementation without RED. Add a clearly synthetic valid RED declaration to that same type before running the retained parser/loader cases. | Preserve all existing Git stub routes, parser/privacy/size/schema substitution oracles and hash calculation. Do not relabel the fixture as doc. |
| Same file, bundled positive at line 121 | Keep inclusive 280, declared GREEN exit 7 and permitted additional data with valid RED. Replace only the `red === undefined` allowance with dedicated missing-RED refusal cases. | Record the exact obsolete assertion and narrow replacement in the pre-fix change; all unrelated assertions stay meaningful. |
| `tests/verification/committed-claims.test.mjs` | Existing defaults are genuine synthetic doc declarations; keep them unchanged. Add bounded selected implementation/test cases with correct publication hashes and separate missing-RED controls. | Retain original publication, Git, selector, privacy and doc-without-RED controls; no new Git method is needed. |
| `tests/verification/generated-claim-hook.test.mjs` | Its validator is an owned argv/exit stub; it does not load the schema. | No prerequisite change is needed. Do not turn it into a duplicate schema suite. |
| `tests/reproducibility-check.test.mjs` | It tests the existing string hash CLI directly and supplies no claim document. | Leave it unchanged; new RED controls prove the old formula remains independent of RED. |
| Locked parser/compiler and copied-package fixtures | Reuse the existing exact module-copy roster and installed locked dependencies. | Missing modules, invalid schema compilation or Git fixture setup failure cannot count as behavioral RED. |

The parent inspected the locked Ajv `required.ts`/`core.ts` sources: current
`strict:true` enables `strictRequired`. A conditional `then` that introduces
a nested proof schema must declare its `red` property as well as requiring
it, or compilation can fail before the intended data assertion. The main
`proof.properties.red` definition owns the value constraints; the conditional
is only the requirement guard. This is an implementation prerequisite, not a
reason to relax strict schema compilation or duplicate the parser. Review
that shape before the first implementation run.

Before execution, independently review the conditional schema/test design.
The new missing/malformed RED cases should fail on the old accepting schema;
retained positive/parser controls and the synthetic-RED prerequisite should
already work. Parent observes and commits the tests/spec before changing the
schema. Parent then runs the bounded changed-binding gate, followed by the
required full/delivery gates. There is no operator-corpus scan, historical
RED replay, database, provider or network prerequisite.
