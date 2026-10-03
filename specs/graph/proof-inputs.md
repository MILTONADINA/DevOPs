# Extract inert proof declarations from a complete local run

**Status**: draft

**Scope:** MR9-A, a standalone read-only input reader supporting future
masterpiece REQ-M2 work. This slice does not implement proof reruns, scanner
measurement, readiness, terminal status derivation or dashboard writes.
Whole REQ-M2 and REQ-M6 remain pending. The owner's continuation and roadmap
Decision 12 permit this bounded read-only infrastructure work; no Workflow
launch, journal discovery, paid call or pipeline change is included.

The current Workflow does not require the nested proof/scans declarations
specified below. This reader accepts explicit input declarations; it does not
claim existing Workflow runs already emit them. Legacy missing declarations
and resumed runs are unsupported rather than silently upgraded.

**M6 source conflict:** `scripts/graph-dashboard/server.mjs` documents native
`launched`, `started`, `result` and `failed` events and explicitly records that
the Workflow's final `cycleOutcome`/`readyForPR` return is not persisted in its
journal. `.claude/workflows/sprint-cycle.js` returns that aggregate to its
caller. M6's requirement to read that final return from the journal therefore
needs a separate contract reconciliation. MR9-A invents no final event and
does not substitute a validator result for the whole cycle.

## REQ-1 — Standalone read-only CLI

THE REPOSITORY SHALL provide:

```text
node scripts/graph-proof-inputs.mjs --run <run-file> --journal <journal-file>
```

THE CLI SHALL accept exactly those two named options, each once, with a
nonempty path value; either option order is valid. Unknown, duplicate,
missing or positional arguments SHALL fail. Relative paths SHALL resolve
against the project root derived from this script's location, never the
caller's working directory. No environment variable SHALL redirect that root
or select an input.

THE CLI SHALL read only the two explicit inputs and SHALL NOT execute their
commands, spawn subprocesses, use a network or scanner, discover journals,
read a path named inside either input, or create/modify/delete files. It
SHALL NOT modify Workflow schemas/prompts, run records, dashboard readers,
hooks or `/sprint` behavior. A successful parse is not a verification result.

**Enforced by:** the standalone CLI and its focused CLI tests.
**Falsified by:** a command string creates a fixture sentinel, an input
redirects the reader to a third file, or invocation changes run/history state.

## REQ-2 — Contained, bounded whole-file inputs

BEFORE opening an input, THE CLI SHALL require that its resolved lexical path
is inside the script-derived project root, that its real path equals that
lexical path, and that the final entry is a regular file. Redirects through
any symlink, including one pointing inside the project, SHALL fail. Missing,
unreadable, nonregular or redirected inputs SHALL fail without reading a
redirected target. The project root is not an input file.

THE CLI SHALL enforce these inclusive byte limits before allocating/reading
the contents, and SHALL bound the actual read so growth cannot bypass them:

| Input | Maximum bytes |
|---|---:|
| Run record | 262144 (256 KiB) |
| Journal | 8388608 (8 MiB) |

THE CLI SHALL validate the opened file's regular type and identity against
the checked entry and detect observed replacement/size changes during its
read; it SHALL close any opened handle on both success and failure. It SHALL
decode whole inputs as strict UTF-8, rejecting invalid bytes, and SHALL hash
their exact bytes including whitespace and line terminators. Empty input
does not become an empty successful declaration set.

The journal SHALL contain at most 10000 physical lines, each at most 262144
bytes excluding its LF or CRLF terminator. A final line terminator does not
add an extra line. Blank lines are allowed and count toward the line limit;
they do not supply events. Every nonblank line SHALL be one complete JSON
object. Invalid JSON or an unsupported event SHALL fail the whole input;
the reader SHALL NOT skip bad lines or accept a truncated suffix.

These are bounded local-read checks, not a portable adversarial filesystem
sandbox. They do not authenticate files or guarantee exclusion of every
concurrent same-user filesystem race. JSON parsing uses ordinary JSON.parse
semantics: duplicate object-member names use the last value. This slice does
not add a custom JSON parser or claim duplicate-member detection; duplicate
events and identity mappings are governed separately below.

**Enforced by:** contained file reads, byte/line/encoding checks and CLI tests.
**Falsified by:** an out-of-root symlink, nonregular input, excessive input,
invalid UTF-8 or malformed journal line yields a successful output.

## REQ-3 — Bind a non-resumed run to the selected local journal

THE run record SHALL be a JSON object with `schema_version: 1`, `cycleId`,
`runId`, an object `args` whose `cycleId` equals the top-level `cycleId`, and
an absolute `journalPath` equal to the selected journal's resolved path.
The journal filename SHALL be `journal.jsonl`, and its immediate parent
directory name SHALL equal `runId`.

Cycle, run and task identifiers SHALL match `[A-Za-z0-9_-]{1,128}` exactly;
raw IDs such as `T1` and `1` remain distinct and are not reformatted. Any
provided record fields outside this required set SHALL NOT supply output
authority or cause further reads.

IF the run has a top-level `resumedFrom` or `priorRunIds` member, or its
`args` has any of `resumedFrom`, `priorRunIds`, `plan`, `priorBuildResults` or
`priorCoderResults`, THEN THE CLI SHALL refuse `RESUME_UNSUPPORTED`, even if
that member is null or an empty array. A project-local copy must explicitly
bind its own local journal path; this tool SHALL NOT copy or follow the
original external journal automatically. `status`, `readyForPR`, verdicts,
acknowledgements and filenames alone SHALL NOT establish verification or
readiness.

**Enforced by:** run-input validation before event extraction.
**Falsified by:** a mismatched cycle/path/run directory or carried result
supplies an accepted proof declaration.

## REQ-4 — Validate native chronology and current attempts

THE journal SHALL begin with exactly one `launched` event as its first
nonblank line. No later `launched` event is allowed. Native event objects
SHALL contain exactly the following fields:

| Type | Required fields |
|---|---|
| `launched` | `type` |
| `started` | `type`, `key`, `agentId`, `label`, `phase` |
| `result` | `type`, `key`, `agentId`, `result` |
| `failed` | `type`, `key`, `agentId` |

`key` and `agentId` SHALL be nonblank strings no longer than 256 characters,
with no ASCII control characters. `phase` SHALL be a nonblank string no longer
than 64 characters, with no ASCII control characters. They are identity and
structural metadata, not executable values or evidence of role success.

THE CLI SHALL maintain a stable one-to-one `key` to `label` binding across
the entire stream. Every `started` SHALL identify a fresh `agentId` for its
attempt; agent IDs SHALL NOT be reused by any later start. Repeating a start
for the same key/agent is a duplicate and SHALL fail. A start for an existing
key is allowed only with its original label, and it clears all prior result
or failure state for that label. A new key SHALL NOT reuse an existing label.

Every `result` or `failed` SHALL follow a start for its key, match that key's
current `agentId`, and be the first terminal event for that current attempt.
Orphan terminals, stale terminals from a superseded agent, duplicate terminals,
conflicting key/label mappings and invented final-result events SHALL fail.
The `result` member is a JSON value at this structural stage; the required
current role-result objects are validated by REQ-5.

WHEN the latest attempt for a required label is failed or still in flight,
THE CLI SHALL refuse instead of retaining an earlier successful result. A
later fresh attempt with one current result may replace an earlier failed
attempt. These rules validate recorded event chronology, not the truth of
an agent's work or a Workflow readiness verdict. Current-attempt checks are
per label: a later planner/coder restart does not establish that an earlier
tester result is causally fresh. Cross-role causal binding belongs to a
future replay/status layer; it is not inferred by this extractor.

**Enforced by:** a strict event-state reader and retry/ambiguity fixtures.
**Falsified by:** an old successful result survives a newer failed/in-flight
attempt, or a stale agent's terminal event supplies the selected result.

## REQ-5 — Require the complete current role and task set

THE final current `planner` result SHALL be an object with a nonempty `tasks`
array. Every task SHALL be an object with a valid unique `id` from REQ-3.
Task descriptions and unrelated plan fields SHALL NOT be output or interpreted
as instructions. Plan order determines tester-declaration output order.

The permitted labels SHALL be exactly `preflight`, `planner`, `reviewer`,
`security`, `validator`, and `coder:<id>`/`tester:<id>` for the final plan's
task IDs. THE CLI SHALL require one final current object result (not null or
an array) for every one of those labels, including preflight. Unknown labels
and unplanned coder/tester IDs SHALL fail. There is no Release agent or native
aggregate event to require or manufacture.

Each final coder and tester result SHALL have `task_id` equal to its raw
planned task ID. Coder, preflight, reviewer and validator results establish
only structural coverage for this input mode; their booleans, outcomes,
findings and free text SHALL NOT establish success or enter the output.
Negative verdicts in otherwise valid result objects do not make this reader
a test runner or readiness calculator.

**Enforced by:** complete-role/task validation against the final planner set.
**Falsified by:** a missing preflight/tester, unplanned task or mismatched
task_id yields successful extraction, or a verdict changes verification.

## REQ-6 — Extract declarations as inert data

Each final tester result SHALL contain an object `proof` with a nonblank
`command` string of at most 8192 characters and an integer `exit_code` in
the inclusive range 0–255. Each final security result SHALL contain a nonempty
`scans` array of objects with:

- `tool`: a string matching `[A-Za-z0-9_-]{1,64}`;
- `command`: a nonblank string of at most 8192 characters;
- `exit_code`: an integer in the inclusive range 0–255;
- `scanned_files`: a nonnegative safe integer.

THE CLI SHALL preserve each command's exact string value as JSON-escaped
data and keep scan declaration order, without evaluating, tokenizing,
normalizing or authorizing execution. Extra proof/scan/result fields SHALL
be omitted. Existing top-level tester `command`/`exit_code` fields SHALL NOT
substitute for a missing nested proof. Malformed or missing required
declarations SHALL fail with no partial output.

A reported nonzero exit or zero scanned_files SHALL remain valid declaration
data. Extracting either does not prove that a command failed, a scanner ran,
or any files were measured. Tool names need not have an installed executable
or floor; this reader neither selects a scanner adapter nor claims one exists.
No command declaration constitutes argv or execution authorization.

**Enforced by:** declaration validation and whitelist projection.
**Falsified by:** a shell metacharacter executes, a reported number is called
measured, or legacy optional fields silently become verified proof.

## REQ-7 — Fixed output and safe failure protocol

WHEN all input checks pass, THE CLI SHALL exit 0, write no stderr, and emit
one JSON object followed by one newline on stdout, with exactly these fields:

```json
{
  "schema_version": 1,
  "cycleId": "example-cycle",
  "runId": "wf_example",
  "run_sha256": "<64 lowercase hexadecimal characters>",
  "journal_sha256": "<64 lowercase hexadecimal characters>",
  "tester_proofs": [
    { "task_id": "T1", "command": "inert recorded text", "exit_code": 0 }
  ],
  "security_scans": [
    { "tool": "semgrep", "command": "inert recorded text", "exit_code": 1, "scanned_files": 0 }
  ],
  "verification": "not_run"
}
```

The digests SHALL be SHA-256 of the exact selected file bytes, not reserialized
objects. The output SHALL contain no input paths, original arbitrary result
objects, timestamps, status, outcome, readyForPR, measured-count or passed
field. `verification` SHALL always equal `not_run`, including when every
reported exit code is zero.

ON any refusal, THE CLI SHALL exit 2, emit no stdout, and emit one stderr
line `graph-proof-inputs: <CODE>` using only this closed diagnostic set:

| Code | Meaning |
|---|---|
| `USAGE` | Invalid CLI arguments |
| `INPUT_PATH` | Input containment or redirect failure |
| `INPUT_FILE` | Missing, unreadable or nonregular input |
| `INPUT_LIMIT` | File, line-count or line-byte limit exceeded |
| `INPUT_ENCODING` | Invalid UTF-8 |
| `INPUT_CHANGED` | Observed file identity/type/size changed during read |
| `RUN_JSON` | Invalid run JSON |
| `RUN_RECORD` | Invalid run shape or identifier |
| `RUN_BINDING` | Cycle/journal path/run-directory mismatch |
| `RESUME_UNSUPPORTED` | Carried plan/results or resume lineage present |
| `JOURNAL_JSON` | Invalid journal JSON line |
| `JOURNAL_EVENT` | Invalid or unsupported native event shape |
| `JOURNAL_ORDER` | Empty journal, missing/late/repeated launch, or start/terminal chronology violation |
| `JOURNAL_BINDING` | Conflicting identity mapping or stale/mismatched terminal agent |
| `PLAN_INVALID` | Invalid, empty or duplicate planned task IDs |
| `ROLE_INCOMPLETE` | Missing/failed/in-flight/non-object current role, unknown/unplanned label, or coder/tester task_id mismatch |
| `DECLARATION_INVALID` | Invalid/missing proof or scan declaration |

Diagnostics SHALL NOT include input paths, raw JSON/parser messages, commands,
result bodies, environment values or user-provided strings. No failure SHALL
be converted into an empty success. Exit 0 means only that extraction met
this schema; neither exit value changes a run record or attests a test result.

**Enforced by:** CLI output projection and success/refusal tests.
**Falsified by:** valid declarations emit verification:passed, a failure dumps
the sentinel input text, or any failure produces a partial success object.

## Acceptance criteria

### AC-1 — Exact binding and inert positive extraction (REQ-1..7)

**Given** owned project-local run/journal fixtures with every current role,
two planned tasks named `T1` and `1`, valid nested declarations, unrelated
sentinel fields and reported nonzero/zero-scan values **When** the CLI runs
**Then** it exits 0 with the exact whitelist, plan-ordered testers, original
scan order/command strings and independently computed exact-byte hashes;
verification is `not_run`, arbitrary fields are absent, and input files and
sentinels remain unchanged. Negative role verdicts do not become readiness.

### AC-2 — CLI and local input boundaries (REQ-1..3, REQ-7)

**Given** wrong/repeated/missing options, a different caller cwd, missing or
nonregular files, lexical escapes, internal/external symlinks within an owned
fixture tree, invalid UTF-8 or excessive byte/line limits **When** the CLI
runs **Then** valid relative paths still resolve from its project root and
all rejected inputs fail with the designated safe category and no stdout.
The tests use an owned sibling as an outside target, never operator files.

### AC-3 — Run identity and unsupported lineage (REQ-3, REQ-7)

**Given** invalid schema/IDs, mismatched args.cycleId, a different journalPath
or parent runId, or any present carried-plan/result/resume member **When** the
CLI runs **Then** it refuses without following the named path or changing
inputs. Null/empty carry members are also refused. No external journal copy
or historical live run is a prerequisite.

### AC-4 — Chronology, retries and complete current roles (REQ-4..5)

**Given** a valid attempt followed by a fresh retry with the same key/label
and new agent **When** that retry produces one result **Then** its declaration
is selected. **Given** a later failed/in-flight attempt, stale old-agent
terminal, repeated start/terminal, orphan terminal, conflicting mapping,
unknown event/label/task, missing preflight or required role, non-object
current result, duplicate plan ID or task_id mismatch **Then** the CLI refuses
instead of selecting an earlier success or inventing aggregate readiness.

### AC-5 — Declaration schema and safe diagnostics (REQ-6..7)

**Given** absent nested proof, empty scans, invalid command/tool/number fields
or legacy top-level proof fields only **When** the CLI runs **Then** it exits
2 with no stdout and a closed diagnostic. Commands and malformed JSON contain
a fixture sentinel; stderr never repeats it. **Given** valid inert commands
containing shell substitutions/metacharacters **Then** extraction preserves
their strings and creates no command-side-effect sentinel.

### AC-6 — Narrow delivery (REQ-1, scope)

**Given** this change's source diff and focused CLI tests **When** reviewed
**Then** no Workflow schema/prompt, orchestration, status updater, hook,
dashboard reader or historical journal changes are required. Tests use only
synthetic owned files and the current Node executable. No Git/npm/network,
scanner, paid Workflow, provider or database call is an acceptance dependency.
Successful extraction is never cited as REQ-M2 rerun proof or REQ-M6 completion.
