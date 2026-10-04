# Security

## Threat model baseline

OWASP Top 10 for Agentic Applications 2026 (released Dec 2025). Every
project's threat model uses `templates/threat-model/STRIDE_ASI_TEMPLATE.md`.

## Tiered scan stack

This is what runs today (2026-09-25). The design goal is in the "Planned" column; it is not
enforced until it moves left.

| Tier | When | Runs today | Gate today | Planned, not wired | Enforced by: |
|------|------|------------|------------|--------------------|--------------|
| 1 | every file write | nothing automatic: `hooks/universal/post-tool/gitleaks-scan.sh` exists but is not wired in `.claude/settings.json` | none | wire the post-tool hook (masterpiece roadmap MR-19 adds a staged-diff pre-commit gitleaks) | Enforced by: UNENFORCED |
| 2 | every PR | gitleaks (diff) and Semgrep (`p/owasp-top-ten`, `p/r2c-security-audit`, `p/secrets`) in `security-scan.yml` | both are required status checks on `main` and fail on any finding (Semgrep since #178) | npm/pip/cargo audit, axe-core | Enforced by: job:.github/workflows/security-scan.yml#gitleaks; job:.github/workflows/security-scan.yml#semgrep |
| 3 | daily and pre-release | gitleaks full-history scan (scheduled, `.gitleaksignore` baseline); DeepTeam red-team, which skips when no provider key is set | the history scan fails its run on a leak; DeepTeam gates nothing while it skips | Trivy | Enforced by: UNENFORCED |

The Enforced by column describes current reference integrity, not new scan evidence.
Tier2 names only the gitleaks and Semgrep jobs; it excludes the Planned column.
The dated snapshot above is preserved. Tier1 and the whole mixed tier3 row remain
UNENFORCED: the existing history-scan job does not establish the row's broader
pre-release or unfunded DeepTeam claims, and no planned scanner is implied to run.

### Local DAST boundary (MR21 / M27)

The [local DAST contract](../specs/security/local-dast.md) is implemented and
verified within its stated scope. Its weekly/manual
[workflow](../.github/workflows/dast.yml) uses pinned nuclei templates and ZAP
baseline. [PR #239](https://github.com/MILTONADINA/DevOPs/pull/239) passed all six
required checks and merged the tested tree. The subsequent default-branch
[Linux/amd64 dispatch](https://github.com/MILTONADINA/DevOPs/actions/runs/37193372293)
passed preparation, application scans, cleanup and evidence upload on
`cf7658df7a95c08746003dd7d1d072cf1f370226`.

The downloaded artifact matched GitHub's published SHA-256 digest. Verification
with the checker from that exact commit accepted the native reports, pinned
identities, isolation and five live health/provider/capture rounds. Preparation
and scanning each removed both owned containers. Nuclei reported no findings;
ZAP reported zero high, two medium and one low findings. The earlier ARM64
application run and real detector controls remain separate evidence. Local
receipts, including `amd64-acceptance.json`, are retained under
`.workflow/proofs/mr21-dast-2026-10-03/`. This completes MR21's local contract;
DAST remains separate from the required PR checks.

For information disclosure and unauthorized targeting, the runner accepts only
`http://127.0.0.1:18080/docs`. A fresh Docker network namespace has no external
network attachment; the proxy, synthetic local provider and scanners share
loopback. Exact interface, route, socket, capability, user and mount observations
are checked. No operator files, provider/database credentials or Docker socket
enter those workloads. Coverage is the unauthenticated personal-mode surface
actually reached; commercial APIs, persistence, erasure, streaming and unreached
operations remain outside it. The detector control is separate from application
evidence and can never receive an application PASS.

For supply-chain tampering and privilege escalation, preparation binds exact
platform image, binary, template, dependency and source bytes. The two upstream
templates, pinned ignore file, complete MIT license and provenance are retained.
Locked dependency installation disables install scripts. The host Docker daemon
and pinned toolchain remain trusted: the bounded HTTP downloader does not mediate
Docker image pulls or npm traffic, and the project host allowlist is not a
workload firewall. ZAP uses a bound one-literal loopback launch derivative and
fixed OAST/HUD disable settings; passive rules and native reports are preserved.

For stale evidence, log injection and incomplete scans, the read-only report
gate bounds files and paths, rejects redirects and malformed inputs, binds
artifacts to the run, and requires native completion, queue witnesses before
report collection and at shutdown, plus actual health checks around both scans.
HIGH/CRITICAL findings fail; lower findings remain visible. Hashes, timestamps
and process identities establish consistency of retained observations, not
remote attestation or an absence of vulnerabilities. Existing Semgrep scope
excludes `vendor/`; its green result does not cover the vendored template bytes.

For resource exhaustion and residual processes, preparation and execution use
bounded deadlines and record owned resources. The finally path exports evidence,
drains the proxy and removes only those resources; cleanup failure remains
visible. Artifact upload runs independently after cleanup. The accepted real
detector controls, unchanged-application scans and successful default-branch
dispatch satisfy this contract's live acceptance gates. Existing pentest-MCP
scope limitations below are unchanged.

### Semgrep report and execution boundary (MR-7 Semgrep slice)

The [CI scan](../.github/workflows/security-scan.yml) prints each report error
as one JSON-escaped `SCAN_DIAGNOSTIC` line. For log tampering and instruction
injection (STRIDE tampering; ASI04), the fixed prefix and escaped newlines keep
embedded text within diagnostic data; readers must treat it as untrusted data.
For information disclosure, error objects may include repository snippets,
paths and rule metadata: this output is not redacted. The reviewed job scans
a fresh checkout, without operator mounts, application execution or restored
private artifacts; this scope does not authorize scanning an operator checkout.
No command, privilege, approval or scanner-exit decision is added by logging.
Workflow shell blocks receive the pull-request base SHA through step `env` and
read event/run identifiers from quoted runner variables. GitHub expression
syntax stays in YAML fields, keeping that metadata out of shell source and
allowing nested Bash parsing; scanner rules and test coverage are unchanged.
The host Node22 checker rejects every finding and nonempty error array,
including warnings, plus malformed reports, duplicate or invalid scanned paths,
missing test trees and a count below `governance/scan-floors.yml`. Its initial
1046 minimum comes from PR #230's error-free required scan; a count does not
establish complete coverage. Scanner nonzero exit statuses survive invalid
reports/configuration. Finding summaries escape control characters and omit
matched-source bodies. The checker reads its two explicit input files only.

For tampering and stale-report replay, the same digest-pinned scanner now runs
as one Docker step with a read-only `/src` checkout and a fresh writable
`/report` directory. It cannot change the host checker or committed floor
through the checkout mount. Container-only Git trust names `/src` exactly;
no host-global Git settings, operator home or Docker socket is mounted or
changed. Host Node avoids assuming a Node executable in the musl scanner
image. Docker launch and scanner failures reach the checker as nonzero status;
missing output fails closed. Registry packs are still remotely resolved, so
pinning the image does not freeze rule content. This narrows the scan boundary;
it does not establish safety of arbitrary container code or every scan target.

DeepTeam/Claude's visible unfunded skips and the rest of MR-7 remain separate
under owner Decision 9. This Semgrep gate does not claim those reviews ran.

### CI baseline acquisition boundary

The [baseline-read contract](../specs/ops/ci-baseline-read-failures.md)
requires the test-floor and spec-status ratchet steps to stop before their Node
checkers when the existing Git fetch or show fails. A missing base member or
failed read cannot be replaced with an empty object that erases the comparison.
Successful reads still supply the exact shown bytes to the existing checkers;
declared lowerings, renames and shrinking status-baseline rules are unchanged.
The checkers' historical standalone empty-object bootstrap is retained, without
making it a CI fallback for unavailable input.

The [added-test discovery contract](../specs/ops/ci-added-test-discovery.md)
also requires the existing `git diff` to finish successfully before `mapfile`
consumes its captured filenames. Empty or partial output from a failed diff
cannot reach the assertion checker or produce a no-added-tests success message.
A successful empty diff and the existing assertion-checker branch are preserved.

The boundary is failure propagation in two existing Bash steps. Their fetch,
`FETCH_HEAD` source selection, test globs and native diagnostics remain unchanged;
this is not a new Git provenance or hostile-filesystem boundary. Existing
line-based filename and Git-quoting limitations remain. The acceptance fixtures
use owned local Git and the copied existing checkers, with no remote service;
their results must remain distinct from an actual hosted CI observation.

### Dependency-audit report boundary (MR19 / M22)

The [dependency-audit contract](../specs/security/ci-dependency-audit.md)
keeps `npm audit --audit-level=high --json` for both root and `runtime/`,
including development dependencies, and the pinned PR dependency-review action
with the high threshold. Either audit can fail without skipping the other tree;
every nonzero npm status remains a failure.

For false passes from malformed or contradictory reports, the inline gate
requires a positive nonboolean integer dependency count, six nonnegative integer
severity counters with a consistent total, and known per-package severities.
High or critical findings in either summary or entries fail independently of
npm's exit status. Unknown extra fields remain allowed; map size is not assumed
to equal dependency or vulnerability counts. This validates a finite report
subset, not report authenticity or the complete npm schema.

For log injection and disclosure through parser errors, invalid reports use a
fixed failure message without report bodies, paths or Python tracebacks. Normal
summaries project validated counters; vulnerable package names and string ranges
are JSON-escaped. Native npm stderr and hosted dependency-review output are
outside that diagnostic boundary and are not claimed to be redacted.

The [acceptance fixtures](../tests/ci/dependency-audit.test.mjs) execute the
actual workflow step with owned npm stubs. Their scope is parser and threshold
behavior; real registry audits and hosted-action execution remain separate CI
observations. The existing local missing-scanner policy and setup's
preservation of alternate hook authority are unchanged; whole MR19/M22 remains
open and M22 remains UNENFORCED.

### Detector source lint boundary (MR22 / M25)

The [detector-source contract](../specs/security/detector-source-lint.md)
requires the three fixed phrases `already fixed`, `do not re-report` and
`known issue` to fail the CI lint when present in inspected detector literals.
It covers the reviewer/security/validator templates and the two named shared
initializers, using decoded text, ASCII case folding and whitespace collapse.
For instruction injection and code execution, Workflow source is parsed as
data by the pinned parser; it is never imported or executed. Dynamic owner,
backlog and result values, arbitrary identifier definitions and phrases built
across separate fragments are outside this finite static analysis. The lint
neither measures detector quality nor prevents runtime prompt injection.

For baseline broadening, each nonempty/non-comment `.gitleaksignore` entry must
use the specified full `commit:file:rule:line` grammar. Existing historical fingerprints
and scanner configuration are preserved. Grammar acceptance does not verify a
finding, its historical approval or the scanner's coverage; the history and
directory scans remain separate evidence. Lint counts are source metadata.

For cross-project disclosure and resource exhaustion, the two fixed inputs
have strict UTF-8 and byte limits with non-symlink regular-file/descriptor
checks. These checks reject observed changes, not arbitrary concurrent tampering.
The parser/Node dependency closure remains trusted. Diagnostics contain fixed
categories and bounded identifiers, never raw prompt/ignore data or exception
text. The lint writes nothing and invokes no subprocess, Git, network or model.
It does not set graph readiness or waive Decision12's delivery/review gates.

### Branch protection drift check (MR-8)

Before a sprint, `branch.protection` compares the current GitHub origin's
`main` protection with `governance/required-checks.yml`. It requires all
configured contexts, strict checks, administrator enforcement and zero
approving reviews under owner Decision 2. The unfunded DeepTeam and Claude
contexts cannot satisfy this policy. Missing or unreadable protection fails
with `needs_human`; the check never repairs GitHub settings.

For request tampering and cross-project disclosure, the new check rebinds its
Git root and origin with inherited `GIT_*` overrides removed, accepts only
three explicit GitHub origin forms, checks the exact API allowlist entry and
uses bounded `gh api --hostname github.com --method GET` argv. Its policy and
allowlist reads resolve within the project. Process and parse failures do not
dump API bodies or credentials into evidence. Tests use owned tool stubs and
keep the original repair, halt and blocked-marker assertions.

This uses the owner's existing authenticated gh. The new check does not audit
every Git configuration source, app binding, GitHub ruleset or bypass route;
legacy checks retain their existing behavior. Policy files remain editable
until MR-4, and settings can change after preflight. GitHub's required checks
remain the merge gate; this additional check detects the specified drift at
preflight time.

### Workflow proof declarations (MR9-A)

The standalone [reader](../scripts/graph-proof-inputs.mjs) accepts two explicit
local inputs and emits tester/security declarations with exact byte hashes and
`verification: "not_run"`, under [the dedicated spec](../specs/graph/proof-inputs.md).
For instruction injection and privilege escalation, commands remain inert
JSON data: the reader invokes no shell, tool, network or model, writes no files
and sets no cycle status or readiness. Reported nonzero exits and zero scan
counts remain declarations; independent execution and measurement are pending.

For cross-project disclosure and resource exhaustion, inputs must be regular
files beneath the script's project root without symlink redirects, within the
256 KiB run-record and 8 MiB journal limits. Descriptor checks and bounded reads
reject observed replacement/growth; UTF-8, line limits and native-event
validation reject malformed inputs. Failure diagnostics contain only fixed
codes. Successful JSON contains command text and is encoded, not redacted.
These controls do not authenticate journal origin or provide an atomic
filesystem sandbox. `JSON.parse` uses the final value of duplicate object
members; hashes identify the original bytes without removing that limitation.

Extraction requires complete non-resumed role coverage and binds each label's
current attempt by key and agent identity. It does not establish cross-role
causal freshness after a planner/coder restart. Native journals contain no final
Workflow `cycleOutcome`/`readyForPR` return, so M6's aggregate premise still needs
reconciliation. Current Workflow schemas and `/sprint` integration are unchanged;
legacy inputs without the required nested declarations are refused. M2 reruns,
scan measurement and M6 status/history derivation remain unfinished work.

### Claim schema loading (MR10-A)

The [validator](../verification/claim-validator.ts) loads its packaged sibling
[schema](../verification/claim-schema.yml), under the
[schema-loading spec](../specs/verification/claim-schema-loading.md).
For policy substitution and cross-project disclosure, a caller's claim cannot
select the schema: schema reads stay within the module's package root, while
claim reads stay within the canonical calling project. Regular-file checks
reject symlink components, and descriptor checks reject observed replacement
or growth. These are finite local checks, not an atomic filesystem sandbox.

For resource exhaustion and ambiguous input, each file is limited to256 KiB
with a bounded read and strict UTF-8 decoding. YAML1.2 core parsing rejects
duplicate keys, anchors/aliases, nonstandard tags, non-JSON values and nesting
above64 collections. Offline draft2020-12 compilation refuses external
references and asynchronous validation; validation does not insert defaults,
coerce types or remove properties. Only the declared `date-time` format is
registered. The fixed packaged schema is policy code, not an authenticated
authority or a sandbox for arbitrary schema extensions.

For diagnostic disclosure and log tampering, new input/parser/compiler
failures use fixed role/category messages and a placeholder ID. Schema failures
print only JSON-escaped schema paths and keywords, without source excerpts,
input property names, command text or environment values. The existing later
Git/hash diagnostics retain their older behavior.

Under the later [command-refusal contract](../specs/verification/claim-replay-refusal.md),
all validator modes require `--no-rerun`. For instruction injection and privilege
escalation, legacy omission is refused before claim discovery, schema loading
or Git checks; the raw declared-command branch and its `.rerun` writes are
removed. The fixed refusal reveals no argument, command or claim contents.
Existing legacy Git routing and diagnostics remain unchanged, as do flagged
metadata selection and empty-set success. This is not a general Git sandbox.
Schema-valid declarations and a recomputed string hash do not independently
prove GREEN, RED, scan results or cycle readiness; safe execution remains open.

The validator boundary is separate from the later [triage refusal contract](../specs/verification/triage-replay-refusal.md).
`scripts/triage-claims.mjs` removes its private Bash executor and refuses before
Git, log/claim reads, model evaluation or output writes when its preserved
literal direct-entry guard matches. Imported helpers remain available; an
explicit `triageOne` call can still evaluate Jev. This adds no safe executor
or model-review evidence. The
historical `scripts/recover-claim-provenance.sh` still omits the required flag
and swallows validator failure, so its old workflow is incompatible with the
new admission rule. That recovery script is not used as acceptance or repaired
by either refusal.
The rest of MR10 remains open.

### RED declaration boundary (MR10-C1)

[The conditional schema policy](../specs/verification/red-declarations.md)
requires RED fields for implementation/test and validates any supplied RED
object for other types. It accepts only a 40-character lowercase hexadecimal
SHA and a nonzero integer exit, without fetching, looking up or executing
anything identified by RED. Existing schema diagnostics remain the boundary
for malformed-field disclosure; RED values are not printed.

A well-formed declaration can still be false. Schema acceptance establishes
neither commit existence/ancestry nor an observed assertion failure. The
unchanged reproducibility hash excludes RED fields; publication hashes bind
bytes without authenticating their asserted history. No historical evidence
is manufactured or retargeted. Safe execution, durable RED retention and
provenance remain open; the validator offers no command replay.

### Completion-state declaration boundary (MR12-A)

The [optional state policy](../specs/verification/completion-state-declarations.md)
constrains supplied `claim.state` values to six exact strings through the shared
schema. Missing state stays missing. For misleading completion claims, a valid
string can still be false: this change provides no convergence, release-graph,
deployment or document-citation evidence, and does not set readiness. The
semantic refusals in AC-M10.1 remain unimplemented.

No state-dependent command or external evidence lookup is added. Existing
controlled schema diagnostics reject malformed values without printing them.
The reproducibility hash excludes state; committed member digests bind its
bytes without authenticating its truth. No historical states are invented or
upgraded. The remaining MR10/MR12 semantic work stays open.

### Readiness-declaration reference boundary (MR12-B)

The [readiness lint](../specs/verification/readiness-claims.md) treats document
text and claim states as untrusted declarations. To prevent authority
substitution, it uses two fixed captured-HEAD document blobs and one fully
validated nonempty committed publication. The new immutable projection copies
only each validated claim ID and its own optional state; there is no inherited
default, working-claim reread, alternative proof store or caller-provided
acceptance list. Existing bounded Git/schema/member checks remain the trust
boundary; local main is not authenticated as a remote assertion.

For disclosure and resource exhaustion, selected blobs are strict UTF8 with
256KiB file and 32KiB physical-line limits. Fixed diagnostic categories reveal
no document excerpts, claim IDs, proof commands/environments or parser errors.
Exact physical declaration/citation boundaries prevent comment removal or
cross-cell borrowing from manufacturing support. Unknown current Status forms
refuse. The historical-table exception binds its exact notice, location and
raw bytes; the reserved notice prefix is checked before fence/comment
exclusions. No generic historical heading suppresses current assertions.

Exact state equality can still associate false or unrelated declarations.
The lint does not run commands, read journals or deployment observations,
contact a service, rank completion states or establish semantic evidence. The
existing reproducibility hash excludes state; member hashes bind bytes only.
Zero declarations report none selected, never ready. Trusted source/dependency
changes can change the checker itself; this is no authenticity or hostile
filesystem sandbox. M10 semantic gates, whole MR12/MR10 and safe proof
execution remain separate work.

### Closure-reference boundary (MR18-A)

The [closure lint](../specs/graph/closure-references.md) checks explicit CLOSED
items in two named documents against the existing validated committed proof
set. For authority substitution, document blobs and publication validation use
one captured HEAD/main context under the finite MR10-B Git boundary. The fixed
`--local-backlog` flag opts into the one named local document, not arbitrary
paths, alternate proof stores or command replay. Even a zero-item result
requires a valid nonempty publication.

For cross-project disclosure and resource exhaustion, local backlog reads are
bounded, strict UTF8 and refuse redirected/nonregular/hard-linked inputs;
Git blobs retain the existing bounded regular-blob checks. Fixed failure
categories expose no item text, claim IDs, command/environment contents or
parser exceptions. Physical status/evidence forms and standalone comment
blocks prevent comment removal from manufacturing a closure literal. The
trusted Node/dependency/Git tools remain outside this finite input policy;
it is not an atomic hostile-filesystem sandbox or remote ref authentication.

A syntactically valid commit/PR citation can be false or unrelated to the item.
Validated claim membership likewise does not observe an execution or establish
closure truth. The lint neither contacts GitHub nor upgrades completion state,
changes freshness dates or repairs historical evidence. Whole MR18/MR10 and
the freshness-hook obligation remain open.

### Tier-3 LLM-orchestrated pentest

Beyond the static tier-3 scanners, DevOPs ships configurations for four
LLM-orchestrated pentest tools that the security subagent invokes when a
project's compliance scope (PCI DSS / HIPAA / COPPA) or non-empty auth surface
warrants deeper assessment. The analyzer's recommendation rule
(`analyzer/scan.ts`) surfaces all four in `recommended.mcp_servers` when those
conditions are met (REQ-A5 / AC-A5.1):

| Tool | Role | MCP config | Per-tool README |
|------|------|------------|------------------|
| **Shannon** | Pentest-LLM orchestrator (top-level coordinator) | [`mcp-configs/universal/shannon.json`](../mcp-configs/universal/shannon.json) | [`shannon-README.md`](../mcp-configs/universal/shannon-README.md) |
| **PentAGI** | Autonomous agent for long-running scan workflows | [`mcp-configs/universal/pentagi.json`](../mcp-configs/universal/pentagi.json) | [`pentagi-README.md`](../mcp-configs/universal/pentagi-README.md) |
| **Lyrie** | RAG-based vulnerability research assistant | [`mcp-configs/universal/lyrie.json`](../mcp-configs/universal/lyrie.json) | [`lyrie-README.md`](../mcp-configs/universal/lyrie-README.md) |
| **pentest-ai** | MCP server exposing nmap / nuclei / sqlmap / ZAP CLI | [`mcp-configs/universal/pentest-ai.json`](../mcp-configs/universal/pentest-ai.json) | [`pentest-ai-README.md`](../mcp-configs/universal/pentest-ai-README.md) |

`subagents/universal/security.md` scopes all four to the `security` role, but nothing
enforces that scoping today: no hook denies them to other roles, the pipeline runs its roles
as Workflow agents with inline prompts, and none of the four MCP servers is registered in this
checkout (`specs/graph/M-masterpiece-standard.md` REQ-M27). All four reference credentials by
env-var name only — no
inline credentials (REQ-A8, gated by tier-1 gitleaks). Lyrie's output
specifically MUST pass through area C's `external-content-boundary.ts` before
re-entering agent context (ASI04 defense).

Upstream-maintenance verification cadence for the four tools is captured at
[`.workflow/maintenance/upstream-verify.md`](../.workflow/maintenance/upstream-verify.md)
(template; cadence enforcement deferred to Phase 3 or later per threat model A
ASI03 row).

Full threat-model context: [`docs/threat-models/phase-2/A-pentest-stack.md`](threat-models/phase-2/A-pentest-stack.md).

## Graph Bash gate boundary (MR-3)

[REQ-M16](../specs/graph/M-masterpiece-standard.md) scopes the registered graph
Bash hooks. Command JSON crosses the host wrapper into a single inert argument;
the adjacent Node classifier reads contained cycle/ref metadata and returns one
validated decision. It never evaluates the proposed command or contacts a
remote. [The installer](../analyzer/install.ts) copies the required companion
beside either selected graph hook; installation does not establish tool wiring.
See [CLAUDE.md](../CLAUDE.md) for actual registration.

**Status: implemented within the stated boundary.** The final 179 focused
cases passed with no failures or skips, bound to the
[classifier](../hooks/universal/pre-tool/graph-command-classifier.mjs),
[deploy wrapper](../hooks/universal/pre-tool/deploy-gate.sh) and
[sealed-ref wrapper](../hooks/universal/pre-tool/block-sealed-refs.sh);
local evidence is `.workflow/proofs/mr3-2026-10-03/focused-green-terminal-binding.json`.
Separate full-suite, review and CI results still govern delivery.

| Threat | Bounded control | Remaining limit |
| --- | --- | --- |
| Authority spoofing (STRIDE spoofing; ASI03/09) | One validated running record; no environment/current-cycle fallback | Plain marker presence does not authenticate a human or bind approval to HEAD |
| Ref tampering / tool misuse (STRIDE tampering; ASI02) | Exact explicit sealed destinations and scoped halt before deploy-only admission; forced bulk/mirror ambiguity refuses | Non-force bulk destinations are not enumerated; arbitrary script files, aliases/functions and generated programs are not inspected |
| Lookup disclosure (STRIDE information disclosure) | Project-contained Git context/metadata, fixed read-only argv and removal of inherited routing/config overrides | This is not a universal filesystem or concurrent-path-race sandbox |
| Decision confusion (STRIDE elevation of privilege) | Exactly one valid companion response; missing/broken helper refuses invocation | File-tool authority protection and general cross-tool enforcement remain separate |
| False refusal / resource loss (STRIDE denial of service; ASI07) | Ordinary diagnostics and inert text remain available during halt | No cancellation of an existing child or rollback of completed work |
| Repudiation | Existing escaped local decision events | Events are mutable and best effort; no immutable audit or universal command redaction claim |

Prompt injection can induce a proposed command (ASI01/04); these hooks constrain
only the recognized resulting Bash forms. They do not establish agent identity,
inter-agent privilege isolation or coverage of arbitrary tools/programs.
Under the repository's ASI mapping, ASI05 memory and ASI08 recursive-agent
operation are unchanged; ASI06 shared-agent privilege and ASI10 uncovered-tool
risks remain outside this slice.
The current wrappers still have malformed/nonstring JSON and failed-extraction
limits; valid-input wrapper fixtures do not close them. Approval signatures,
protected state paths, broader tool parity and proof-ledger accounting remain
MR-5/MR-4/MR-6/MR-10. Unhalted `gh pr merge` remains marker-exempt under Decision 13;
a halted merge is refused, and required GitHub merge checks remain independent.
Ordinary non-force `--tags`, `--follow-tags` and `--all` pushes are deploy-gated,
but the sealed hook does not enumerate their implicit destinations. Explicit
protected right-hand refspec destinations remain blocked. This is not a claim
that every implicit Git mutation is mediated.

The focused fixtures under `tests/hooks/` exercise synthetic command/authority
and installation boundaries without performing deployments or destructive
commands. Their results must be reported with the tested source binding; an
advisory DeepTeam/Claude skip is not semantic-security evidence. Roadmap
Decision 9 keeps both reviews visibly skipped while unfunded; funding remains
the owner's decision, with no new paid red-team requirement for this slice.

## Skills

- `security/owasp-asi-threat-model` — STRIDE + ASI 2026 modeling
- `security/prompt-injection-defense` — content sanitization
- `security/gitleaks-scan` — secret detection
- `security/semgrep-scan` — static analysis
- [`security/webhook-idempotency`](../skills/universal/security/webhook-idempotency/SKILL.md) — idempotency-key + replay-window + dedupe-storage discipline for webhook receivers (ASI02 Tool Misuse defense; universal across Stripe / GitHub / Slack / Twilio / SendGrid)

## Red team

Run `deepteam` with `OWASP_ASI_2026()` framework before any release that
changes agent behavior:

```python
from deepteam import red_team
from deepteam.frameworks import OWASP_ASI_2026
result = red_team(model_callback=your_agent, framework=OWASP_ASI_2026())
```

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it through GitHub
private vulnerability reporting:
<https://github.com/MILTONADINA/DevOPs/security/advisories/new>. Only the
maintainer can read the report.

**Owner action required.** Private vulnerability reporting is a repository
setting, and it was disabled on 2026-09-26. The repository owner must enable
it (repository Settings → Code security → Private vulnerability reporting)
before this link accepts reports. Until it is enabled, open an issue at
<https://github.com/MILTONADINA/DevOPs/issues> that asks for a private channel
and contains no vulnerability details.

This policy covers the whole repository, including Stratum (`runtime/`).
`runtime/SECURITY_POLICY.md` points here for the reporting channel.

Include in your report:

- a description of the vulnerability
- steps to reproduce
- the potential impact
- any proof-of-concept code, if you have it

### Scope

DevOPs runs on the user's own machine. There is no hosted service to test.

In scope:

- the Stratum proxy: authentication bypass, API-key handling, token
  injection, data exfiltration
- memory stores: access to one organization's data from another organization
- API endpoints: authorization flaws, IDOR, injection
- safety hooks and gates in `hooks/` and `.claude/settings.json`: a way to
  bypass a hook that is wired and claims to block an action
- the claim validator and proof ledger (`verification/`): a way to get a
  false claim accepted
- skill signing and provenance: a way to install a tampered skill without
  detection

Out of scope:

- vulnerabilities in third-party services or tools (LLM providers, Supabase,
  Docker, GitHub). Report those to the vendor.
- vulnerabilities in dependencies. Report those to the dependency's
  maintainer, and tell us so the dependency can be updated here.
- hooks that this document or `CLAUDE.md` lists as not wired
- denial of service by resource exhaustion on your own machine
- social engineering

### Good-faith research

We will not take legal action against anyone who researches and reports in
good faith under this policy: who reports promptly, does not access or change
other people's data beyond what is needed to show the issue, does not exploit
it for personal gain, and gives the maintainer a reasonable time to fix it
before disclosing it publicly (90 days from acknowledgement). Reporters are
credited in the advisory unless they prefer to stay anonymous.

## See also

- `governance/owasp-asi-2026/threats.md` — full ASI 2026 reference
- `docs/OWASP_ASI_THREAT_MODEL.md` — modeling guide
