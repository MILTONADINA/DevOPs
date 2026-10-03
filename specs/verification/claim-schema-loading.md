# Load the committed claim schema for validation

**Status**: draft

**Scope:** MR10-A, the schema-loading portion of masterpiece REQ-M9 under
the owner's roadmap continuation. This slice replaces the validator's
handwritten YAML and shape checks with the actual local JSON Schema. It does
not approve or complete the whole masterpiece draft.

Acceptance uses the existing explicit-file invocation with `--no-rerun`.
Claim discovery, default replay, Git/file checks and reproducibility-hash
semantics remain separate work. In particular, default replay currently runs
claim-controlled shell text and is not a safe execution boundary. This slice
does not authorize running it.

## REQ-1 — Load the validator's packaged schema

WHEN the existing selection logic supplies at least one claim, THE VALIDATOR
SHALL load the fixed sibling `claim-schema.yml` beside the running
`verification/claim-validator.ts` module. The module's package root SHALL be
derived from its location, not the caller's working directory. No environment
variable, claim member or command-line schema option SHALL select another
schema. A same-named file in the caller's project SHALL NOT override it.

THE VALIDATOR SHALL resolve each selected claim path relative to the canonical
working directory; an absolute path SHALL be accepted only when it stays
inside that root. This claim root retains the existing Git/hash authority.
The schema SHALL be contained within the validator's package root; a packaged
validator may be outside the consuming claim project's root. Each input
SHALL be a regular file within its respective root. Any symlink component
below that root, including an internal redirect, SHALL cause
refusal before the redirected target is read. Missing or unreadable inputs,
directories and other nonregular entries SHALL fail validation.

This binds packaged policy separately from the caller's claims and Git
context. It does not make an arbitrary working directory a trusted repository
or harden existing Git routing. The implementation SHALL preserve the selection logic,
including the empty-selection result. It SHALL NOT enumerate additional
proof directories or discover historical claims for this feature.

**Enforced by:** the schema/claim loading boundary in
`verification/claim-validator.ts` and focused CLI tests.
**Falsified by:** a changed local schema has no effect, a claim selects a
different schema, or an input redirect causes an outside target to be read.

## REQ-2 — Parse bounded, unambiguous YAML data

BEFORE reading content, THE VALIDATOR SHALL reject a schema or claim larger
than262144 bytes (256 KiB). That limit is inclusive. The actual read SHALL be
bounded so file growth cannot cause unbounded allocation. THE VALIDATOR SHALL
decode the whole accepted input as strict UTF-8. Invalid UTF-8 SHALL fail.

THE VALIDATOR SHALL parse exactly one YAML1.2 core-schema document per file.
An explicit directive selecting a different YAML version SHALL fail.
It SHALL accept JSON-compatible mappings with string keys, arrays, strings,
finite numbers, booleans and null. It SHALL reject duplicate mapping keys,
anchors, aliases, nonstandard tags, multiple documents and non-JSON key/value
shapes. Empty input or an empty YAML document SHALL fail. Collection nesting
SHALL be limited to64 levels, counting the root collection as level1.

THE VALIDATOR SHALL use a maintained YAML parser instead of extending the
existing YAML-lite implementation. Standard quoted escapes, flow syntax and
literal/folded strings SHALL retain their YAML-defined values. Parser warnings
about unsupported tags or invalid syntax SHALL NOT become accepted data.

These are finite local-input checks, not an atomic filesystem sandbox or a
claim of protection against every concurrent same-user filesystem race.
The implementation SHALL close any opened input handle on success and failure.

**Enforced by:** bounded input loading and the YAML parser's explicit policy.
**Falsified by:** an alias or duplicate-key document becomes a valid claim,
invalid UTF-8 is silently replaced, or a file above the cap is accepted.

## REQ-3 — Enforce the actual schema without mutating claims

WHEN YAML decoding succeeds, THE VALIDATOR SHALL compile the loaded schema
as JSON Schema draft2020-12 using a real schema validator. It SHALL apply the
schema's declared constraints, including type, enum, pattern, required,
minLength, maxLength, array items/minItems, integer/minimum and object
additionalProperties constraints. The declared `date-time` format SHALL be
validated when present.

THE VALIDATOR SHALL compile synchronously without a network loader. An
asynchronous schema/compiled validator SHALL fail; a returned Promise SHALL
NOT be treated as a validation result. Schema
references SHALL be limited to same-document fragments; external file/HTTP
references SHALL fail instead of fetching another resource. The standard
draft2020-12 `$schema` identifier selects the built-in dialect; it is not a
network request. Missing, malformed or uncompilable schema data SHALL fail.

THE VALIDATOR SHALL NOT coerce types, insert defaults or remove properties.
It SHALL pass unchanged decoded claim values to the existing Git/file/hash
checks only after schema validation succeeds. It SHALL NOT add restrictions
absent from the committed schema: this slice does not require zero declared
exit, forbid all additional properties, add `proof.red`, require completion
state or invent human approval. Changes to those policies require their own
schema/spec change.

The new YAML, draft2020-12 validation and format libraries SHALL be explicit
locked root production dependencies, because `verification/` ships in the
package and its imports must survive production dependency installation.
Existing `tsx` placement and installer behavior SHALL remain unchanged.

**Enforced by:** compilation of `verification/claim-schema.yml`, declared
locked dependencies and focused schema-driven acceptance tests.
**Falsified by:** a300-character description passes despite maxLength280,
an enum/type violation passes, or a schema default mutates the decoded claim.

## REQ-4 — Fail safely and retain the read-only acceptance mode

IF loading, parsing or compiling a schema/claim fails, THEN THE VALIDATOR
SHALL exit nonzero with a fixed diagnostic identifying the input role and
failure category. It SHALL NOT print parser exceptions, source excerpts,
input filenames, malformed claim IDs, command text or environment values.

IF a claim violates the compiled schema, THEN THE VALIDATOR SHALL report
the failing schema keyword and a JSON-escaped schema path. It SHALL NOT dump
the offending value or the full schema-validator error object. A claim ID
SHALL be displayed for these new failure paths only after its value satisfies
the committed ID constraint; otherwise a fixed placeholder SHALL be used.

WHEN invoked with the existing explicit claim-file argument and
`--no-rerun`, THE VALIDATOR SHALL NOT execute `test_command` or create a
`.rerun` file. The new parser/compiler SHALL make no subprocess or network
calls. Existing metadata Git checks remain outside the parser and retain
their current behavior. Success means the existing checks, now including
the actual schema, accepted declared data; it does not mean the declared
command, GREEN or RED was independently observed.

THE VALIDATOR SHALL preserve current default replay code, discovery modes,
Git/file-check behavior and reproducibility-hash calculation except for
passing the correctly decoded, schema-validated values to those checks.
This preservation is not a security endorsement of raw shell replay.
WHEN existing selection finds no claims, THE VALIDATOR SHALL retain exit0
and the existing empty-selection message without requiring a schema file.
Nonempty committed proof selection, `--claim`, spec-anchor validation, SHA
reachability, RED replay and `/sprint` integration remain pending MR10 work.

**Enforced by:** controlled error formatting, existing `--no-rerun` boundary
and preserved selection/replay/Git/hash source.
**Falsified by:** a malformed claim leaks its contents, an inert command
creates a sentinel, or this slice breaks CI solely because no claims exist.

## Acceptance criteria

### AC-1 (REQ-1, REQ-3)

**Given** an owned copy of the validator/package schema and a separate owned
claim project with a valid synthetic claim **When** the explicit-file CLI
runs from the claim project with `--no-rerun` **Then** it passes with
controlled Git/hash prerequisites. Changing the copied sibling schema's
maxLength constraint changes the result; a same-named schema in the caller's
project does not. Missing, invalid, asynchronous and external-reference
schemas fail without fallback. No input member can redirect schema selection.

### AC-2 (REQ-2, REQ-3)

**Given** the committed schema **When** otherwise valid claims contain a
300-character description, a missing required field, invalid type enum,
invalid pattern, wrong scalar/array-item type, negative duration or invalid
date-time **Then** validation fails naming the relevant schema keyword.
The inclusive280-character description succeeds. Valid quoted/block YAML
retains its decoded value and the matching reproducibility hash. A declared
nonzero integer exit, an extra property permitted by the schema and a type
`implementation` claim without `proof.red` remain shape-valid in this slice.

### AC-3 (REQ-1, REQ-2)

**Given** owned input fixtures **When** a file is outside the project,
redirected at its leaf or parent, nonregular, missing, malformed UTF-8,
oversize or malformed YAML **Then** it fails safely. Duplicate keys,
aliases/anchors, unknown tags, multiple documents, non-string mapping keys
and excessive collection depth fail. Valid comment-padded files at exactly
the byte cap succeed with otherwise valid schema/claim contents; exceeding
the cap fails before content parsing.

### AC-4 (REQ-3, REQ-4)

**Given** synthetic claim commands/environment containing a sentinel
**When** schema validation fails **Then** diagnostics contain no sentinel,
parser excerpt or malformed ID. A failure identifies its keyword and schema
path. **When** a valid explicit claim runs with `--no-rerun` **Then** its
command stays inert and input/output files remain unchanged. Schema defaults
and coercible values do not alter the claim to make it valid.

### AC-5 (REQ-4)

**Given** an owned empty proof directory or an absent one **When** existing
`--all --no-rerun` runs **Then** the existing empty message and exit0 remain,
including when no schema file exists. This is deliberate compatibility, not
completion of AC-M9.1's future nonempty-set requirement. Existing Git/hash
positive controls remain valid under the new parser. Tests SHALL invoke only
explicit owned files with `--no-rerun`, apart from these empty-discovery
compatibility controls; they SHALL NOT replay raw shell commands or read
operator proof history.

Focused tests SHALL be discoverable as
`tests/verification/claim-schema-loading.test.mjs` under the existing root
test glob. They SHALL use the locked local TypeScript launcher and synthetic
project fixtures without network/authentication/model/database dependencies.
