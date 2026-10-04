# Claim-validator replay refusal

**Spec ID:** verification/claim-replay-refusal
**Status:** approved (bounded Decision12 security/script-exit correction)
**Last updated:** 2026-10-04
**Scope:** remove validator execution of declared commands while preserving explicitly opted-in metadata validation; safe replay and whole M2/M9 remain open.
Root selected this direct security/script-exit correction under Decision12;
whole M2/M9, graph integration and safe replay remain unfinished.

## Scope and explicit compatibility amendment

The current validator can run a schema-valid declaration's command after
recording Git or reproducibility-hash failures. Schema acceptance and the
claim-supplied reproducibility checksum do not authorize execution. This
contract removes that validator execution path; it does not add an executor.

This later contract supersedes only:

- MR10-A `claim-schema-loading.md` REQ-4's preservation of default replay,
  and legacy omission admission. Its empty-selection compatibility remains
  when the literal `--no-rerun` flag is supplied.
- MR10-C1 `red-declarations.md` REQ-4's statement that legacy raw-replay source
  is preserved. All RED declaration shapes and other requirements remain.
- Inherited MR10-B compatibility prose only insofar as it preserves that same
  legacy replay availability. Its committed selection/parser, metadata
  requirements, publication, historical README seed and acceptance remain.

No prior receipt, source snapshot, dated history or historical seed is rewritten.
The existing schema, Git checks, hash calculation, committed publication,
immutable declarations, closure/readiness consumers and generated hook remain
unchanged. No AGENTS, graph, hook, dependency, schema, package-script or
`runtime/` application-source edits belong to this implementation. Root separately authorizes
only the two active skill documentation corrections named in REQ-4. Separate
triage/recovery executors are excluded.

## REQ-1 — Refuse legacy omission before selecting data

**Enforced by:** test:tests/verification/claim-replay-refusal.test.mjs
WHEN the existing committed-selector parser rejects arguments, THE VALIDATOR
SHALL preserve its current `committed: usage\n` stderr, empty stdout and exit1.
WHEN that parser selects committed mode, THE VALIDATOR SHALL retain the existing
committed branch without changing its accepted argument forms or outcomes.

WHEN arguments select legacy mode without the exact `--no-rerun` token,
THE VALIDATOR SHALL exit1 before legacy proof-directory discovery, claim or
schema reads, Git metadata checks or declared-command execution.
THE VALIDATOR SHALL emit only the following fixed stderr line for that refusal:

```text
claim validation: command replay is disabled; use --no-rerun
```

THE VALIDATOR SHALL emit no stdout for that refusal.
This includes zero arguments, an empty owned proof directory, explicit files,
missing/invalid inputs and lookalike `--no-rerun=...` options. Module loading
is not claim/schema loading; existing locked module prerequisites remain.

## REQ-2 — Remove validator command execution and replay writes

**Enforced by:** test:tests/verification/claim-replay-refusal.test.mjs
THE VALIDATOR SHALL NOT execute any `proof.test_command` value in any CLI mode.
THE VALIDATOR SHALL NOT create a declared output directory or `.rerun` artifact
as a consequence of validating a declaration.
THE VALIDATOR SHALL remove the private raw-command replay function and its
call/options plumbing rather than retaining a bypassable execution branch.
THE VALIDATOR SHALL provide no argument or environment bypass for replay.

Existing Git metadata subprocesses remain. This requirement is not a general
Git sandbox, environment sanitizer or repository-wide ban on every executor.

## REQ-3 — Preserve flagged metadata behavior

**Enforced by:** test:tests/verification/claim-replay-refusal.test.mjs; test:tests/verification/claim-schema-loading.test.mjs; test:tests/verification/committed-claims.test.mjs; test:tests/verification/generated-claim-hook.test.mjs; test:tests/reproducibility-check.test.mjs
WHEN legacy arguments contain the exact `--no-rerun` token, THE VALIDATOR SHALL
preserve current explicit single/multiple-file and implicit local selection.
THE VALIDATOR SHALL preserve current legacy filtering of other option tokens.
This slice adds no general CLI parser or new duplicate-option restriction.

WHEN flagged implicit selection is empty, THE VALIDATOR SHALL retain exit0,
`No claim files to validate.\n` stdout, empty stderr and no schema load.
WHEN flagged selection is nonempty, THE VALIDATOR SHALL preserve packaged
schema authority, bounded input policy, actual schema/RED/state validation,
Git/file checks, reproducibility-hash calculation, per-claim results, summary
and exit policy. Declared nonzero command exit codes remain metadata.

THE VALIDATOR SHALL preserve `parseCommittedSelection`, the committed
validation implementation and the shared input/Git modules byte-for-byte.
THE VALIDATOR SHALL preserve the existing legacy Git-check and hash function
bodies byte-for-byte. Removing replay parameters/calls is the only change
inside the surrounding legacy validation flow.

## REQ-4 — Keep evidence and consumer statements bounded

**Enforced by:** PROCESS
WHEN documenting this correction, THE DOCUMENTATION SHALL state that omitted
legacy metadata opt-in is refused and `--no-rerun` acceptance validates declared
data/metadata without observing a command result.
THE DELIVERY RECORD SHALL distinguish controlled synthetic pre-fix execution
from any statement about historical claims or actual exploitation.
THE DELIVERY RECORD SHALL leave safe GREEN/RED replay, durable RED provenance,
semantic completion and whole M2/M9 integration open.

Current consumer prose that says this validator still offers unsafe replay
needs a narrow documentation update after approval. Root authorizes minimal
validator-invocation and metadata-assurance prose corrections in exactly
`skills/universal/process/proof-of-work/SKILL.md` and
`skills/universal/process/session-summary/SKILL.md`. These documentation
corrections require explicit authorized metadata selection with `--no-rerun`
and distinguish it from independently observed proof. They do not change graph/pipeline logic or authorize a general skill rewrite. Root has narrowed
the previously carried no-skill scope for these exact documentation changes.

The separate triage executor and historical recovery script remain excluded;
their compatibility/safety limits must be disclosed rather than described as
fixed. Existing CI/generated-hook invocations already supply `--no-rerun`.
No historical command is selected or executed to test this contract.

## Acceptance criteria

### AC-1 — Admission precedes discovery and metadata

Given owned inputs and a logged Git stub, omitted legacy opt-in yields the
exact REQ-1 refusal, no Git calls, no probe marker and no replay artifact.
Cover explicit and implicit nonempty input, empty/no-argument input, invalid
schema/input precedence, and a lookalike flag. Committed malformed selectors
retain `committed: usage`, without entering legacy discovery.

### AC-2 — Witness and remove the unsafe branch

Given a schema-valid synthetic claim whose command is the single fixed owned
probe, old-source observation records that the probe can run both for accepted
metadata and after deliberate Git/hash failures. The corrected CLI refuses
before either action. The probe writes only one predetermined marker beneath
the owned fixture and exits0; it has no network or external data access.
This is a required controlled old-source witness, not authorization to run
arbitrary declaration commands or historical proofs.

### AC-3 — Preserve metadata controls

Flagged explicit one/multiple files and implicit nonempty selection retain
normal metadata results and exact expected Git calls. Flagged empty selection
remains successful even with absent sibling schema. Flagged invalid Git/hash
metadata still refuses without executing the probe. Existing schema,
committed-publication, generated-hook and reproducibility tests are unchanged;
existing nonempty committed positives remain the publication control.

### AC-4 — Source and evidence boundaries

Inputs and copied source remain unchanged. The corrected validator creates no
probe or `.rerun` files. New usage output contains no argument, input excerpt,
command/environment text, filesystem path or sensitive sentinel. Source
review confirms removal of the replay implementation/call and exact preserved
function/module bytes. Missing loader dependencies, setup errors, signals or
timeouts cannot count as intended RED. Observed proof, metadata acceptance
and remaining excluded executors are described separately.
