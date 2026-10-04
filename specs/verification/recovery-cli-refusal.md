# Historical recovery CLI refusal

**Spec ID:** verification/recovery-cli-refusal
**Status:** approved (bounded Decision12 security/script-exit correction)
**Last updated:** 2026-10-04
**Scope:** disable incompatible automatic recovery; preserve historical evidence and leave safe execution open.
**Delivery base:** `1e03e311f07f3512742ff0ccbadc2ee6a7fe683a` (PR252).

Root selected this reversible script-exit/security correction under the owner's
continuation instruction and roadmap Decision12. PR252 delivery and final
contract/test source review preceded promotion. Implementation follows
meaningful RED and the tests/spec commit. This does not approve the whole
masterpiece specification or authorize safe replay.

## Source defect and scope

At the delivery base, `scripts/recover-claim-provenance.sh` invokes the validator without
`--no-rerun`. The validator refuses before claim discovery. Recovery merges
stderr into a human-output filter ending in `|| true`, so this failure becomes
an empty missing-SHA set and exit0 with “nothing to recover.” The same filter
cannot distinguish loader/tool failure from an empty successful selection.
These are current source facts; no historical claim or command was inspected
or executed to establish them.

This later contract disables that historical CLI. It extends only the recovery
exclusion left by `claim-replay-refusal.md` REQ-4 and
`triage-replay-refusal.md` REQ-4; it does not amend their validator/triage
behavior or retrospectively attribute this correction to those deliveries.
Masterpiece M2/M9 and roadmap MR9/MR10 still require separately specified safe
execution, durable RED retention and graph integration. No requirement below
claims to restore missing commits or assess historical proof validity.

## REQ-1 — Refuse unconditionally before recovery work

**Enforced by:** test:tests/verification/recovery-cli-refusal.test.mjs
WHEN the script body is entered using either explicit Bash execution or its
existing executable `#!/usr/bin/env bash` entry, THE RECOVERY CLI SHALL exit1
with empty stdout and exactly this stderr line, including one final LF:

```text
claim provenance recovery: automatic recovery is disabled
```

THE SCRIPT SHALL perform this refusal before argument parsing, Git or npm
invocation, repository discovery, directory changes, claim/log/config reads,
validator execution, network requests, fetch, ref updates, push, model calls
or output-file writes. Its refusal body SHALL use only Bash built-ins.
THE SCRIPT SHALL treat every argument as inert, including no arguments,
`--push`, option lookalikes and arbitrary missing/directory path arguments.
THE SCRIPT SHALL NOT echo arguments, paths, environment values, input excerpts
or caught tool errors.

This is a script-body boundary. Interpreter resolution and Bash startup occur
before that body: the contract does not claim isolation from hostile PATH,
BASH_ENV, ENV, exported functions, shell replacement or an altered interpreter.
No sourcing API or all-interpreter/all-entry-spelling behavior is introduced.
The existing shebang and executable mode remain supported and unchanged.

## REQ-2 — Remove the incompatible private workflow

**Enforced by:** PROCESS
THE SCRIPT SHALL remove its old argument parsing, repository selection,
validator-output parsing, missing-SHA loop, remote fetch, local ref mutation,
optional wildcard push and final claimed-pass summary.
THE SCRIPT SHALL replace its obsolete operational usage/“zero-risk” header
with a concise description of disabled availability and the dedicated spec.
THE SCRIPT SHALL provide no flag or environment bypass and no replacement
executor, metadata recovery mode, input format or remote-write interface.

THE CHANGE SHALL leave the validator, triage/Jev helpers, package scripts,
dependencies, existing tests, CI, graph/run-record code, hooks, skills and
runtime application source unchanged. It does not add `--no-rerun` to revive
automatic historical selection.

## REQ-3 — Preserve history and describe the remaining limits

**Enforced by:** PROCESS
WHEN documenting this correction, THE DOCUMENTATION SHALL amend only the
current recovery statement in `docs/SECURITY.md` to describe early refusal and
its interpreter boundary. The validator and triage descriptions SHALL remain
unchanged except a necessary joining sentence for that exact paragraph.
THE CHANGE SHALL preserve historical `SHIP_BLOCKERS.md`, dated recovery
accounts, historical claim YAML/scripts/logs, claim dispositions and published
claim members without selecting, rewriting, moving or deleting them.

THE DOCUMENTATION SHALL state that refusal is not provenance recovery,
historical invalidation, safe command execution or completion of M2/M9/MR10.
No other consumer edit belongs to this slice unless a concrete current
operational contradiction is source-reviewed and explicitly added before the
contract/tests freeze. No such additional consumer is selected here.

## REQ-4 — Keep test evidence and delivery bounded

**Enforced by:** PROCESS
THE ACCEPTANCE TESTS SHALL use the current real script copied into owned
fixtures, actual Bash, and source-reviewed owned Git/npm stubs. They SHALL NOT
invoke real npm, Git fetch/push/update-ref, the validator, a historical proof,
a model or a remote. Stubs SHALL never delegate to those real tools.

WHEN observing RED, THE SAME DEFAULT CASE SHALL establish the old false-success
path using an npm stub which emits the current fixed validator refusal and
exits1. THE TEST SHALL retain a fixed structured witness before its new refusal
assertion. No separate preliminary recovery run is permitted. The witness
SHALL distinguish stubbed validator refusal from actual validator execution.
The new code SHALL satisfy the fixed refusal with zero Git/npm calls and no
fixture-output mutation.

THE TEST FIXTURES SHALL use existing owned ordinary/non-repository directories
as process CWD. Missing-path and directory-path values are inert arguments;
a nonexistent CWD that prevents process launch is not valid refusal evidence.
THE TESTS SHALL preserve all old test bytes and avoid a redundant argument
matrix or tests that merely reproduce the implementation text.

THE DELIVERY RECORD SHALL distinguish intended RED assertions from fixture,
loader, shell-availability or timeout failures and preserve every attempted
run. Any necessary recovery SHALL select only affected failed cases.
THE CHANGE SHALL be limited to the new spec/test, recovery script and the
current SECURITY statement, plus the measured floor update below.
WHEN the full root suite has completed and its exact-source result is accepted,
THE CHANGE SHALL permit `governance/test-floors.json` to raise only the root
floor to the observed passing count with an evidence comment. Runtime floor,
ratchet policy and all other source SHALL remain unchanged. No predicted
count is a passing observation or permission for an early floor increase.

Decision12 delivery still requires RED first, required CI, exact PR/full-head
approval and independent security review. Funding, signing, graph delivery,
other-client access and safe-replay policies are not supplied by this contract.

## Acceptance criteria

### AC-1 — Observe and remove the false success

Given the copied script, an owned Git stub returning only the fixture root and
an owned npm stub emitting the exact current validator refusal with exit1,
the ordinary explicit-Bash no-argument RED case observes the old script's
exit0 and its empty-selection success text, with one Git and one npm call.
That same case records its fixed witness before requiring the new exit1,
empty stdout and exact private stderr. After implementation the witness records
zero Git/npm calls and the false-success text is absent. No real claim or
validator is consulted; fixture source/input paths and bytes are unchanged.

### AC-2 — Preserve supported entry while making options inert

The direct executable entry uses the existing shebang and executable mode with
an actual available Bash under the fixture's controlled PATH. `--push` refuses
with the same private output and zero tool/ref/network actions. One grouped
explicit-Bash case supplies inert unusual options plus missing/directory path
arguments; they never appear in diagnostics. Existing owned non-repository CWD
works, and tool-error text cannot replace the fixed refusal. This is not an
assertion about a nonexistent CWD or hostile shell startup.

### AC-3 — No private recovery workflow or historical mutation

Source review establishes removal of the old parsing/fetch/ref/push workflow,
no bypass or replacement, preserved shebang/executable support, and unchanged
validator/triage/Jev/package/CI/graph/hook/skill/runtime sources and old tests.
Owned fixtures establish no output/ref/proof writes. Historical source docs and
proof artifacts are neither discovered nor rewritten; the narrow SECURITY
amendment accurately distinguishes disabled availability from recovery.

### AC-4 — Account for the bounded delivery

The final record binds the exact delivered base, meaningful same-run RED,
tests-first commit, focused GREEN, required unchanged-source checks and full
result. It retains any fixture failures without calling them RED and records
only a measured post-full root-floor/comment raise. Current historical claim
validity, safe execution, M2/M9 completion and funded review remain unclaimed.

## Source and fixture prerequisites before behavior

- Root must bind the actual delivered triage merge SHA before any source sync,
  receipt acceptance or claim generation. The delivery base is recorded above.
- Source-review the exact copied shell, new test and generated Git/npm stubs.
  Observe Bash availability and syntax-check the script/test/generated wrappers
  before RED without importing the test or executing the stub bodies.
- Explicit Bash uses an inspected absolute Bash path with clean environment;
  executable entry resolves the unchanged env shebang to an owned symlink to
  that Bash. The fixture also needs the old path's actual grep/sort utilities,
  supplied through inspected fixed paths. Missing tools are fixture failures.
- Git accepts only the exact old `rev-parse --show-toplevel` lookup and returns
  the owned root. Any other call is logged and refuses; no real Git is needed.
  npm accepts only the exact old `run validate:claims --silent` arguments,
  writes the fixed current refusal to stderr and exits1. No package loader runs.
- A Node built-in-only harness can use the existing child-process fixture style;
  every child has a finite timeout/output cap and a clean environment without
  BASH_ENV/ENV/credentials. There are no installs or external prerequisites.

The proposed five-file product roster is the new spec/test, recovery script,
`docs/SECURITY.md` and the observed floor/comment. Source bindings record the reviewed preparation; root owns all behavior,
Git operations and delivery gates.
