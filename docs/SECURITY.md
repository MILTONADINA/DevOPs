# Security

## Threat model baseline

OWASP Top 10 for Agentic Applications 2026 (released Dec 2025). Every
project's threat model uses `templates/threat-model/STRIDE_ASI_TEMPLATE.md`.

## Tiered scan stack

This is what runs today (2026-09-25). The design goal is in the "Planned" column; it is not
enforced until it moves left.

| Tier | When | Runs today | Gate today | Planned, not wired |
|------|------|------------|------------|--------------------|
| 1 | every file write | nothing automatic: `hooks/universal/post-tool/gitleaks-scan.sh` exists but is not wired in `.claude/settings.json` | none | wire the post-tool hook (masterpiece roadmap MR-19 adds a staged-diff pre-commit gitleaks) |
| 2 | every PR | gitleaks (diff) and Semgrep (`p/owasp-top-ten`, `p/r2c-security-audit`, `p/secrets`) in `security-scan.yml` | both are required status checks on `main` and fail on any finding (Semgrep since #178) | npm/pip/cargo audit, axe-core |
| 3 | daily and pre-release | gitleaks full-history scan (scheduled, `.gitleaksignore` baseline); DeepTeam red-team, which skips when no provider key is set | the history scan fails its run on a leak; DeepTeam gates nothing while it skips | Trivy, Nuclei, ZAP (roadmap MR-21) |

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
