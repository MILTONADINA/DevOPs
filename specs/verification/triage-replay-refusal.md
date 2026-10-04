# Triage CLI replay refusal

**Spec ID:** verification/triage-replay-refusal
**Status:** approved (bounded Decision12 security/script-exit correction)
**Last updated:** 2026-10-04
**Scope:** disable direct CLI command replay; preserve imported helpers and leave safe execution open.

Root selected this reversible security/script-exit correction under the owner's
continuation instruction and roadmap Decision12. Implementation follows the
current validator-refusal delivery, reviewed acceptance source and meaningful
tests-first RED. It does not approve the whole masterpiece specification.

## Scope and explicit supersession

`scripts/triage-claims.mjs` separately executes a declaration's `test_command`
with Bash before any Jev-key gate. A log naming a claim and the claim's own
declared exit do not authorize command execution. The existing validator's
refusal does not cover this separate CLI.

This later contract supersedes `specs/graph/J-jev-judgments.md` REQ-J8's current
CLI rerun/model/report availability and AC-J8.1's real-key acceptance **only for
this removed CLI path**. The original J8/AC text and dated approval remain
unchanged; an enforcement note names this narrow supersession. J8 remains
`UNENFORCED`. J1–J7/J9, the Jev client, helper APIs and their acceptance remain
unchanged. Refusal does not deliver safe triage, model review or M2/M9 replay.

The old triage entry guard is deliberately retained. Requirements below use
“direct CLI” to mean only invocations for which this existing expression is true:

```js
import.meta.url === `file://${process.argv[1]}`
```

This is not a promise that every symlink, escaped-path or alternate Node entry
spelling matches the guard. The existing false-guard import/symlink behavior
is preserved. There is no new replay bypass or replacement executor.

## REQ-1 — Refuse before selecting or acting on data

**Enforced by:** test:tests/jev/triage-replay-refusal.test.mjs
WHEN the existing direct-entry guard selects the CLI, THE TRIAGE CLI SHALL
exit1 with empty stdout and exactly this stderr line, including one final LF:

```text
claim triage: command replay is disabled
```

THE TRIAGE CLI SHALL refuse before Git, log or claim reads, key resolution,
child-process creation, model evaluation and report/output writes.
THE TRIAGE CLI SHALL treat all supplied arguments as inert for that refusal.
This includes no arguments, `--from-log` with empty/nonempty/missing/invalid
input, `--out`, prior concurrency/timeout options and option lookalikes.
Module loading is not a selected log/claim/key read; the existing sibling
Jev module remains an input prerequisite.

THE TRIAGE CLI SHALL NOT echo an argument, command, path, environment value,
input excerpt or caught input error in this refusal.

## REQ-2 — Remove the private executor and its plumbing

**Enforced by:** test:tests/jev/triage-replay-refusal.test.mjs
THE TRIAGE SCRIPT SHALL remove private `readClaim`, `runProof` and `pool`.
THE TRIAGE SCRIPT SHALL remove their child-process/filesystem/path imports and
the old argument parsing, claim loop and Markdown-output plumbing.
THE TRIAGE SCRIPT SHALL replace the obsolete replay/usage header with a concise
description of this refusal and the preserved helper API.
THE TRIAGE SCRIPT SHALL provide no flag or environment bypass for replay.
THE TRIAGE SCRIPT SHALL NOT introduce a new executor, model CLI, report-input
format or metadata-only triage mode.

This requirement removes this script's raw proof execution. It is not a
repository-wide ban on execution or a general safe-execution implementation.

## REQ-3 — Preserve imported behavior and the current entry guard

**Enforced by:** test:tests/jev/triage-replay-refusal.test.mjs; test:tests/jev/triage-claims.test.mjs
THE TRIAGE SCRIPT SHALL preserve byte-for-byte the `CAUSES` and
`CAUSE_CRITERIA` declarations and the five exported function declarations:
`failingIdsFromLog`, `redactTail`, `buildQuestions`, `triageOne`, `renderTable`.
These comprise the existing six exported values. Their existing associated
helper comments remain unchanged.
THE TRIAGE SCRIPT SHALL preserve the Jev import and existing direct-entry
guard/catch block byte-for-byte.
THE CHANGE SHALL preserve `scripts/jev.mjs` and every pre-existing test file
byte-for-byte.

WHEN the existing direct-entry guard is false, THE TRIAGE SCRIPT SHALL retain
its current inert import behavior. In particular, an owned symlink invocation
whose argv URL differs from the module URL retains the existing no-CLI
behavior; it is not reinterpreted as a matching entry point in this slice.

`triageOne` retains its existing default evaluator. Explicit callers can still
invoke that model API; preserving the helper does not make it a pure function
or promise that arbitrary callers cannot access the network. Existing tests
inject its evaluator. Importing the module does not evaluate it.

## REQ-4 — Bound consumer statements and evidence

**Enforced by:** PROCESS
WHEN documenting this correction, THE DOCUMENTATION SHALL distinguish direct
CLI refusal from the preserved imported helper behavior.
THE CHANGE SHALL update only the current triage statement in `docs/SECURITY.md`
and the J8 enforcement note, in addition to the new spec/test and triage script.
The only additional permitted product change is the measured root-floor update
below. WHEN the full root suite has completed and its exact-source result is
accepted, THE CHANGE SHALL permit `governance/test-floors.json` to raise only
the root floor to the observed passing count with its evidence comment.
THE CHANGE SHALL preserve the runtime floor and existing ratchet policy.
No floor increase or count is authorized before that accepted observation.
THE CHANGE SHALL preserve J8's `UNENFORCED` annotation, its original requirement
and AC text, all other J requirements, and the historical recovery limitation.

THE DELIVERY RECORD SHALL distinguish the controlled synthetic old-source
probe from historical proof execution or actual exploitation.
THE DELIVERY RECORD SHALL retain any fixture/prerequisite failures and scope
later recovery to their affected cases.
THE DELIVERY RECORD SHALL leave safe replay, durable RED provenance, funded
model review, graph integration and whole M2/M9 open.

No AGENTS, active skill, Workflow, run-record, hook, runtime, dependency,
package-script, schema, validator or recovery-script change belongs here.
No historical claim or real journal is selected. No model call is authorized
as acceptance for this slice. This is separate from the earlier validator
contract's expressly excluded triage path.

## Acceptance criteria

### AC-1 — Direct refusal is early and private

Given a copied real triage script and its unchanged Jev sibling, a direct
invocation whose entry guard matches returns the exact REQ-1 refusal.
Cover no arguments and grouped prior-option inputs with missing, invalid,
empty and nonempty synthetic logs plus an explicit output path. Logged owned
Git/Python stubs receive no calls; no proof marker or triage report is created.
Arguments and sentinels do not appear in stdout/stderr. A missing dependency,
syntax failure or timeout is not an acceptable refusal.

### AC-2 — Witness old execution once inside meaningful RED

Given a wholly owned log/declaration fixture, the old-source run executes one
fixed harmless proof and creates its fixed marker. That proof is fixed absolute
Node plus an owned script, has no network or external data access, and exits0.
The synthetic declaration expects0, so the old CLI takes `passes_now` and
never asks Jev. Its expected report and Git/Python calls are retained evidence.

The same acceptance case emits a bounded structured witness before its
decisive refusal assertion. After correction, that case observes no Git/Python
call, proof marker or report, and the fixed refusal. No preliminary replay,
arbitrary command or historical proof is required or authorized. The old run
and corrected run remain separately attributed.

### AC-3 — Existing helpers and guard behavior remain

Given an owned import caller, importing the actual copied module is inert and
exposes the existing six values. The unchanged six helper tests continue to
exercise log selection, redaction, questions, injected classification and
table rendering. An owned symlink control with a false existing guard remains
inert and does not produce the direct-refusal line. No test expects a live Jev
call or a new entry-path normalization policy.

### AC-4 — Preserve sources and account for the scope

Source comparison proves the exact REQ-3 declarations, import/entry block,
Jev file and all old tests unchanged. It proves the private executor/plumbing
removed and no replacement bypass introduced. Owned source and fixture input
paths/bytes remain unchanged during acceptance; only the fixed old-source
marker/report and fixture call logs are permitted observation outputs.
Missing tools, loader errors, setup failures, signals or timeouts cannot count
as intended RED. Record every such failure and any targeted recovery honestly.
The consumer delta retains the historical/normative boundaries in REQ-4.

## Source and fixture prerequisites before behavior

- Capture the two real module bytes once and copy them unchanged into a fresh
  owned fixture. Use an ordinary ASCII absolute fixture path whose direct-entry
  comparison matches; import and symlink controls are separate. No fallback
  directory or old proof enumeration is allowed.
- Inspect and syntax-check the exact frozen new test, copied source and owned
  wrappers before meaningful RED. Parent owns every execution. Existing tests
  stay unchanged; tests/spec are committed before implementation.
- An owned Git stub admits only `rev-parse --show-toplevel`. An owned Python
  stub admits only the source's fixed `-c` program and exact synthetic claim
  path, then emits the fixed declaration. No real Python/PyYAML installation,
  real Git data or local claim content is needed.
- Bind actual Bash availability and the absolute Node executable. The fixed
  owned probe is the only permitted shell command in the witness; a fake Bash
  that merely writes an expected marker cannot establish the old behavior.
- Child environment is constructed without provider credentials or key-file
  settings; controlled expected-exit equality prevents Jev evaluation in the
  old witness. Container network isolation, if used by the parent, is separate
  evidence from those source/fixture properties.
- Freeze case names, expected mixed-RED partition, witness shape and exact
  source hashes before execution. No registration count or passed outcome is
  inferred by this draft. Focused evidence precedes any long full gate.

## Delivery boundary

PR251 delivery and final contract/test source review preceded product promotion. Decision12 requires RED first, required checks, independent security
review and an exact PR/head approval record. Existing CI checks and funding
policy are unchanged. This administrative paragraph records preparation,
not an additional runtime requirement or a whole-roadmap completion claim.
