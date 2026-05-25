# AGENTS.md — DevOPs Universal Contract

> This file is read by every modern coding agent on session start: Claude Code,
> Codex CLI, Cursor, Antigravity, Kiro, Gemini CLI, Copilot, Windsurf, Aider, Devin.
> It is the universal operating contract for DevOPs.
>
> **Do not modify this file in your project. To customize per-project behavior,**
> **edit `AGENTS.override.md` (not committed) or your project's `/specs` directory.**

---

## First actions (mandatory, in order)

Before responding to anything, the agent MUST:

1. Read `constitution/PRINCIPLES.md` and load it as the immutable operating frame.
2. Read `constitution/ANTIPATTERNS.md` for the explicit don'ts.
3. Read `constitution/LOOP.md` for the goal-driven execution protocol.
4. Check `.workflow/state/baton.md`. If it exists and `last_updated` is within 24
   hours, **resume from `next_action`** rather than starting fresh.
5. Check `.workflow/client/profile.yml` if present. Load client name, allowed
   data classes, compliance scope, and pentest authorization. Do not operate
   outside this scope.
6. Verify the project profile is current: if `package.json` (or equivalent
   manifest) `mtime` is newer than `.workflow/profile.yml`, re-run the analyzer
   before proceeding.

---

## The eight principles (full text in `constitution/PRINCIPLES.md`)

1. **Think Before Coding.** Don't assume. Don't hide confusion. Surface tradeoffs.
   If something is unclear: stop, name what's confusing, ask. Do not pick an
   interpretation silently.

2. **Simplicity First.** Minimum code that solves the problem. No speculative
   abstractions. No "flexibility" that wasn't requested. If you write 200 lines
   and 50 would do, rewrite.

3. **Surgical Changes.** Touch only what you must. Don't refactor adjacent code.
   Match existing style. **Every changed line must trace directly to the user's
   request or to a spec line.**

4. **Goal-Driven Execution.** Transform every task into testable success
   criteria, then loop until verification passes. Don't stop because you "think"
   it's done; stop when verification confirms it.

5. **Verifiable Claims (Proof of Work).** Every claim ships with structured
   proof: git SHA, files changed, command run, exit code, output tail. Claims
   without proof are rejected.

6. **Surgical Honesty Across Tool Handoffs.** On session end, write
   `.workflow/state/baton.md` with current state. On session start, read it.
   Next tool resumes exactly where this one stopped. No context loss.

7. **Client Boundary Discipline.** Never read, write, or transmit data outside
   the current project root. Never operate on a different client's data.
   Compliance scope from `client/profile.yml` is enforced.

8. **Spec-Anchored Implementation.** Every commit must trace to a section of
   `/specs/`. No work that isn't speccable. Specs use EARS notation
   (see `docs/EARS_GUIDE.md`).

---

## Mandatory checkpoints

The following are NON-NEGOTIABLE. They fire as deterministic hooks regardless
of the agent's intent:

- **Hard budget brake**: if session cost exceeds `cost-controls/budget.yml`, the
  process is killed. No exceptions.
- **Loop detection**: if the same tool is called with identical arguments more
  than N times (default: 5), the process is halted.
- **Scratchpad stasis**: if state has not progressed in N iterations (default:
  3), the process is halted with a blocker written to
  `.workflow/state/blockers.md`.
- **Secret block**: any attempt to read or write `.env`, `*.pem`, `*.key`, etc.
  is blocked.
- **Production write block**: any write to branches matching `main`, `master`,
  `production`, `release/*` requires explicit human confirmation via
  `.workflow/state/approvals.jsonl`.
- **External network whitelist**: outbound HTTP is restricted to domains in
  `.workflow/network-allowlist.txt`.

These are implemented in `hooks/universal/` and cannot be disabled by the agent.

---

## Spec-driven development

DevOPs uses spec-driven development with EARS notation. The lifecycle:

```
Requirements artifact (from user)
    ↓
specs/ directory (EARS-formatted, version controlled)
    ↓
Acceptance tests (derived from specs, written first)
    ↓
Implementation (the loop: code → run tests → iterate until pass)
    ↓
Proof of work (verified by claim-validator)
    ↓
Human review (session summary with all verified claims)
    ↓
Merge (only with all gates green)
```

If you receive a request that doesn't have a corresponding spec:

1. Ask whether to create one (`skills/universal/process/spec-extraction`).
2. If the user wants you to proceed without a spec, **refuse for anything
   non-trivial.** Trivial = single-line edits, typo fixes, doc updates.

---

## Multi-tool failover

DevOPs is designed for session continuity across tools. When your session limit
is approaching:

1. Run `/checkpoint` (or invoke `baton-handoff` skill).
2. The baton is written to `.workflow/state/baton.md`.
3. User opens the next tool (Claude Code → Codex → Cursor → local LLM).
4. That tool reads the baton on session start and resumes.

Local LLM fallback uses the same SKILL.md files via OpenCode, Aider, or any
agent that supports universal skills.

See `docs/FAILOVER.md` for the full protocol.

---

## Modes

DevOPs supports multiple operational modes, each with different rule sets:

- `greenfield` — building from scratch
- `brownfield` — adding to existing code, surgical edits only
- `migration` — moving from one tech to another, with parallel running
- `hotfix` — minimal scope, maximum safety, fast path
- `refactor` — preserve behavior, change structure
- `debug-prod` — investigate without changing
- `audit` — read-only review

Determine the active mode from `.workflow/state/active-mode.txt`. If absent,
default to `brownfield` for safety. See `modes/` for the full rule sets.

---

## Lifecycle phase

Each project moves through phases: discovery → design → build → harden → launch
→ operate → evolve. The current phase is recorded in `.workflow/state/lifecycle.txt`
and gates which skills are available. See `lifecycle/` for phase definitions.

---

## Memory

DevOPs ships with three memory backends in order of preference:

1. **File-based** (always on): `.workflow/memory/` — git-committed, durable,
   reviewable. Read on every session start.
2. **Stratum** (recommended for production): structured fact tables + git
   attestation. Configured in `memory/stratum/config.yml`.
3. **Zep** (for semantic temporal queries): self-hosted via Docker. Configured
   in `memory/zep/docker-compose.yml`.

All three may be active simultaneously. See `docs/MEMORY.md`.

---

## Cost controls

Model routing is automatic per `cost-controls/model-routing.yml`:

- **Haiku 4.5** → routine tasks, classification, simple code, code review
- **Sonnet 4.6** → default for complex implementation
- **Opus 4.7** → architecture decisions, novel problems, planning

Use Anthropic Batch API for non-real-time work (50% discount). The constitution
layer is configured for prompt caching.

---

## Observability

Every action emits OpenTelemetry spans with `user_id` and `tenant_id` in
baggage. PII is redacted at the exporter before reaching the backend.

Backends supported: Langfuse, Laminar, Arize Phoenix. See
`observability/README.md` for setup.

---

## Skills catalog (always available)

The following universal skills are available without explicit invocation. The
agent decides which to use based on each skill's description:

- `spec-extraction` — turn user requirements into EARS-formatted specs
- `plan-decomposition` — break spec into atomic verifiable tasks
- `baton-handoff` — write session state for next-tool resume
- `proof-of-work` — produce structured verification artifacts
- `session-summary` — generate human-reviewable end-of-session report
- `ask-dont-assume` — surface ambiguity as blockers
- `multi-tool-failover` — manage Claude Code → Codex → local LLM rotation
- `karpathy-guidelines` — behavioral rules (vendored)
- `goal-loop` — implement the spec → test → iterate → verify cycle
- `surgical-edits` — enforce the "every line traces" rule
- `ears-spec-writing` — author specs in EARS notation
- `openapi-first` — generate code from API contracts
- `owasp-asi-threat-model` — produce STRIDE+ASI threat models
- `prompt-injection-defense` — sanitize external content entering context
- `gitleaks-scan` — tier-1 secret detection (runs on every file write)
- `semgrep-scan` — tier-2 OWASP Top 10 + security-audit rulesets (runs in CI)
- `webhook-idempotency` — idempotency keys + replay-window for webhook handlers
- `observability-instrument` — add OTel spans with baggage
- `cost-attribution` — track per-client AI/cloud spend
- `coppa-audit` — COPPA compliance review (since referenced in user stack)

Stack-specific skills are installed by the analyzer based on the project profile.

---

## Verification protocol

Every claim the agent makes about its work MUST conform to the claim schema in
`verification/claim-schema.yml`:

```yaml
claim:
  id: "claim-YYYY-MM-DD-NNN"
  type: implementation | test | scan | deploy
  spec_ref: "specs/<file>.md#<section>"
  description: "<one sentence, factual>"
  proof:
    git_sha: "<commit hash>"
    files_changed: [...]
    test_command: "<exact command>"
    test_exit_code: 0
    test_output_path: ".workflow/proofs/<id>-test.log"
  confidence: high | medium | low
  reproducibility_hash: "<sha256 of (command + env)>"
```

Claims without proof fail validation. Claims with `confidence: low` require
explicit human review before merge.

---

## Local override

For per-machine or experimental settings that should not be committed, create
`AGENTS.override.md` in the project root. It is gitignored and loaded after
`AGENTS.md` (its contents override). Codex CLI also reads
`AGENTS.override.md` natively.

---

## Tool-specific files

The following tool-specific files reference back to this `AGENTS.md`:

- `CLAUDE.md` — Claude Code adapter
- `.codex/AGENTS.md` — Codex CLI extension
- `.cursorrules` — Cursor rule
- `.windsurfrules` — Windsurf rule
- `GEMINI.md` — Gemini CLI

If you find conflicting instructions, `AGENTS.md` wins.
