# DevOPs

> A self-configuring, verification-first DevOps workflow for AI coding agents.
> Designed to work with Claude Code, Codex CLI, Cursor, Antigravity, Kiro,
> Gemini CLI, Copilot, Windsurf, and local LLMs via universal SKILL.md and
> AGENTS.md formats — **currently, only Claude Code has a real adapter**
> (`CLAUDE.md`); the other eight are aspirational until their adapter files
> actually exist. Don't take the multi-tool claim as shipped.

DevOPs is not a framework. It is an *operating system for coding agents* that ships
with a constitution, deterministic safety hooks, a per-project analyzer that
auto-configures itself to each new repo, cryptographically verified proof-of-work,
multi-tool session handoff, and a persistent memory backend.

It is built to deliver the full DevOps cycle — from a vague client brief through
spec, design, build, harden, launch, operate, evolve — autonomously where it can be
verified, and with explicit human checkpoints where it cannot.

---

## What's actually differentiated

A redundancy audit (2026-09-14) forced an honest split — most of this project
leans on tools that already exist. Worth knowing which parts are which before
trusting a "why build this" answer.

**Hard to get elsewhere — the real reasons to use this over an off-the-shelf
tool:**
- The claim/proof-of-work verification system (`verification/claim-validator.ts`)
  — reproducibility hashes, exit-code re-verification, refusal to accept
  self-reported "done."
- Stratum's context-pruning eval gate (KadaneDial) — semantic-retrieval +
  LLM-judge + quality gate before a prune is trusted. Still shadow-mode,
  pending a live judged eval — the design addresses a genuinely unsolved
  problem (long-context hallucination/cost), it just isn't proven yet.
- Stratum's multi-provider gateway — deliberately *not* built on LiteLLM;
  needs exact per-provider token counts for billing accuracy that LiteLLM's
  response normalization doesn't guarantee (see `stratum/docs/decisions/0019-multi-provider-gateway.md`).
- Stratum's billing/invoice engine — a real Stripe revenue mechanism tied to
  measured token savings, not a generic cost dashboard.
- Stratum's typed Tier-2 memory (server-trusted FK injection, fail-closed
  validation) — architecturally different from generic memory products
  (mem0/Letta/Zep store blobs or embeddings, not typed multi-tenant facts).
- The project analyzer's compliance/risk classification (PCI/GDPR/COPPA/HIPAA
  detection driving downstream skill recommendations) — goes beyond what
  `/init`-style auto-configuration does.

**Built on Claude Code's own native primitives, curated rather than
invented:** the hooks/skills/subagents *mechanisms* are platform features,
not DevOPs inventions. The value here is "specific rules already written for
you" (loop-detection thresholds, budget brakes, the constitution), not "does
something the platform can't do." Don't oversell this part.

**Removed 2026-09-14 as redundant with existing tools** (full detail in
`CHANGELOG.md`): the Zep memory backend, three process skills that
duplicated Claude Code's native behavior (`ask-dont-assume`,
`karpathy-guidelines`, `surgical-edits`), the `researcher` subagent
(duplicates the native Explore agent), and Stratum's vanilla cost dashboard
(duplicates Langfuse/Helicone).

---

## Why

Clyro, which sells agent-governance tooling, reports that of 591 agent
incidents it collected (2023–2026; the dataset is not published), **88% of
those it could classify traced to infrastructure gaps, not model quality**
([Clyro, Apr 2026](https://clyro.dev/blog/the-5-ai-agent-failure-modes-why-they-fail-in-production/)). Its five failure modes are below. The shares
are Clyro's; the examples are not from its dataset.

| Rank | Failure mode | Share | Example |
|------|--------------|-------|---------|
| 1 | Context Blindness | 31.6% | Agent forgets a decision made 50 turns ago (illustrative) |
| 2 | Rogue Actions | 30.3% | Amazon's Kiro agent reportedly deleted and recreated an AWS Cost Explorer environment, a ~13h outage in one region (FT, Feb 2026; [Amazon](https://www.aboutamazon.com/news/aws/aws-service-outage-ai-bot-kiro) attributes it to misconfigured access controls) |
| 3 | Silent Degradation | 24.9% | Output quality drifts week-over-week, unnoticed (illustrative) |
| 4 | Memory Corruption | 8.1% | Persistent memory poisoned by adversarial input (illustrative) |
| 5 | Runaway Execution | 5.1% | A Claude Code subagent retried one failing command 300+ times over ~4.6h, using ~27M tokens (user report, [anthropics/claude-code#15909](https://github.com/anthropics/claude-code/issues/15909)) |

DevOPs is the infrastructure that fixes all five — without trusting the model to
behave. The mantra: **you cannot ask an agent if it is in a loop; you must prove it
mathematically.**

---

## Architecture at a glance

DevOPs is layered. Each layer constrains the layer above it.

```
                ┌──────────────────────────────────────┐
                │  Your code, your project             │
                ├──────────────────────────────────────┤
                │  Skills (model-invoked playbooks)    │ ← Tier 3 stack-specific
                │  Subagents (specialized roles)       │
                │  Slash commands                      │
                ├──────────────────────────────────────┤
                │  Constitution (immutable principles) │ ← Tier 1 universal
                │  Modes & Lifecycle states            │
                │  Universal process skills            │
                ├──────────────────────────────────────┤
                │  Hooks (deterministic, always fire)  │ ← Safety floor
                │  Budget brakes, loop detection       │
                │  Pre/post-tool, session-start/end    │
                ├──────────────────────────────────────┤
                │  Memory: Stratum + file-based        │ ← Persistence
                │  Verification: claim-validator       │
                │  Observability: Langfuse + OTel      │
                └──────────────────────────────────────┘
```

The Constitution sits *above* every skill and *below* every action. Hooks sit
*outside* the LLM cognitive space — they execute regardless of what the agent
intends.

---

## Universal portability

The same DevOPs install works across every major coding agent through standard
formats:

| Tool | Entry file | Skill format |
|------|-----------|--------------|
| Claude Code | `CLAUDE.md` + `.claude/` | SKILL.md |
| Codex CLI | `AGENTS.md` | SKILL.md |
| Cursor | `.cursorrules` | derived from SKILL.md |
| Antigravity | `AGENTS.md` | SKILL.md |
| Kiro | `AGENTS.md` + steering files | SKILL.md |
| Gemini CLI | `GEMINI.md` | SKILL.md |
| Copilot | `copilot-instructions.md` | SKILL.md |
| Windsurf | `.windsurfrules` | derived from SKILL.md |

`AGENTS.md` (donated to the Linux Foundation in December 2025) is the universal
root contract. SKILL.md is the universal skill format. DevOPs uses both and
generates per-tool adapters automatically.

---

## What's in the box

### Constitution (Karpathy + DevOPs extensions)
- `constitution/PRINCIPLES.md` — eight principles, each with tradeoff and working signal
- `constitution/ANTIPATTERNS.md` — explicit don'ts with examples
- `constitution/LOOP.md` — the goal-driven iteration protocol

### Process skills (universal, every project)
- Spec extraction (EARS notation)
- Plan decomposition
- Baton handoff (multi-tool session failover)
- Proof-of-work claim verification
- Session summary (human-reviewable)
- Goal-driven loop

(Three others — Ask-don't-assume, Surgical edits, Karpathy guidelines — were
removed 2026-09-14 as redundant with Claude Code's own native behavior;
their real enforcement mechanisms, where they had one, live in
`verification/claim-validator.ts` and the hook layer, not in a skill.)

### Hooks (deterministic safety)
- Pre-tool: secret block, prod-write block, `rm -rf` block, network whitelist, **budget brake**, **loop detection**, client boundary
- Post-tool: auto-format, gitleaks scan, type check
- Session-start: load baton, load constitution, verify project profile
- Session-end: write baton, generate summary, log events

### Project analyzer
Scans the project, detects stack/domain/compliance scope/risk profile, and recommends
the right skills + hooks + MCPs + subagents to install. Modeled on Anthropic's
`claude-code-setup` plugin, extended with installation, learning, and per-client
isolation.

### Memory (two-tier, both wired)
- **File-based** — `.workflow/memory/` git-committed durable facts (works today)
- **Stratum** — your own context-pruning proxy with structured fact tables, audit_conflicts, billing_records (Phase 0+1 ready, advanced phases incoming)

(A third backend, Zep, was removed 2026-09-14 as redundant dead weight — zero
call sites ever wired it in, and Stratum's own ADR-0004 argues its approach
is inferior to the structured facts above. Semantic-temporal recall across
sessions is currently unsupported.)

### Verification (anti-hallucination)
- Every claim must produce a structured proof (git SHA, test command, exit code, output tail)
- `claim-validator` re-runs proofs and confirms exit codes match
- No claim with confidence `low` reaches human review without explicit flag
- Reproducibility hash on every proof

### Modes (different rules per task type)
Greenfield, brownfield, migration, hotfix, refactor, debug-prod, audit. Each
has a `MODE.md` that overrides the default behavior set.

### Lifecycle states
Discovery → Design → Build → Harden → Launch → Operate → Evolve. Each phase has
its own skill bundle and acceptance gates.

### Cost controls (mechanical, not advisory)
- Hard per-session USD budget with reserve-commit pattern
- Tool-call repetition detection (same call N times = halt)
- Scratchpad-stasis detection (no progress N iterations = halt)
- Three-tier model routing (Haiku/Sonnet/Opus) with 50-80% documented savings
- Anthropic Batch API routing for non-real-time work (50% discount)
- Prompt cache configuration for constitution layer

### Observability (production-grade from day one)
- OpenTelemetry with semantic conventions (OpenInference)
- Per-tenant attribution via OTel baggage (every span knows whose client it served)
- Inline PII redaction at span exporter
- Langfuse and Laminar configs both included
- Production replay support

### Security (OWASP ASI 2026 throughout)
- Threat model template per project (STRIDE + OWASP ASI 2026)
- Goal-hijacking defense (sanitization of all external content entering context)
- Memory poisoning detection (git-attestation via Stratum)
- Identity/privilege scoping per subagent
- Skill signing + provenance (against AST10 supply-chain attacks)
- Pentest stack: gitleaks, semgrep, Nuclei, ZAP, Playwright, pnpm-audit, jwt-cli + Shannon, PentAGI, pentest-ai integrations

---

## Quick start

DevOPs runs on your own machine; there is no hosted service. Nothing in this
Quick start requires a paid account. Tools you choose to connect (an LLM
provider, for example) may have their own charges, billed by that provider.

These are plain shell commands, so you can also open this repository in your
AI coding agent and ask it to follow this section.

**Prerequisites**

- macOS, Linux, or WSL2 (native Windows is not supported)
- `git` and `bash`
- Node.js 20.11 or later. The analyzer runs TypeScript directly, so it also
  needs either `tsx` (`npm i -g tsx`) or Node.js 22.6 or later.
- Optional, only for the local Stratum database and proxy: Docker with
  Compose, and a running Docker engine
- Optional: `cosign`, to verify skill signatures during install. Without it,
  the installer falls back to the manifest's SHA-256 check.

```bash
# 1. Clone DevOPs (one-time). The scripts default to ~/DevOPs.
git clone https://github.com/MILTONADINA/DevOPs.git ~/DevOPs

# 2. Install: marks the hook and script files executable
cd ~/DevOPs && ./scripts/install.sh

# 3. In any new or existing project:
cd ~/my-project
~/DevOPs/scripts/analyze.sh        # detects stack, writes .workflow/profile.yml
~/DevOPs/scripts/init-project.sh   # installs the recommended config
```

If step 1 clones to `~/DevOPs` as shown, you do not need to set
`DEVOPS_ROOT`: the scripts default to that path. `DEVOPS_ROOT` matters only
if you clone somewhere else in step 1. Then set
`export DEVOPS_ROOT=/path/to/your/clone` before step 2, keep it set in your
shell rc file, and use your clone path in place of `~/DevOPs` in steps 2 and
3, because `install.sh` and `init-project.sh` both default to `~/DevOPs`
(without it, `install.sh` copies the clone there). To call `analyze.sh` and
`init-project.sh` without the full path, add `export PATH="$DEVOPS_ROOT/scripts:$PATH"`
to your shell rc file, as `install.sh` prints.

`init-project.sh` copies `AGENTS.md` and `CLAUDE.md` into the project (it
does not overwrite existing ones), copies the recommended skills, hook
scripts and subagents into the project's `.claude/` directory, and, in a git
repository, writes `.git/hooks/pre-commit`. **This overwrites any existing
pre-commit hook in the project without a backup**, so copy yours aside first
if you have one. It does not write `.claude/settings.json`,
so the copied hook scripts run only after you wire them there (this
repository's own `.claude/settings.json` is a working example; `docs/HOOKS.md`
lists what each hook does). Other coding agents read `AGENTS.md`; see the note at the
top of this file about which adapters exist.

See `docs/PLAYBOOK.md` for the full operational guide.

For the optional local Stratum database and proxy smoke check, install Docker
Compose and run `npm run setup` from this repository root. See
`stratum/README.md` for provider setup and proxy startup.

### Executable bits

Some scripts (`scripts/devops-cli.js`, hooks) carry POSIX executable
bits (`100755`) in the git index. If your tooling surfaces these as
phantom modifications, suppress them by setting `core.filemode=false`
locally:

```bash
git config core.filemode false
```

The `.sh` hooks require a POSIX shell (bash/zsh) and can be invoked with
`bash <hook>.sh`.

---

## Documentation

| Doc | What it covers |
|-----|----------------|
| `docs/PLAYBOOK.md` | How to actually use DevOPs on a real project |
| `docs/ANALYZER.md` | How project analysis and auto-configuration work |
| `docs/HOOKS.md` | The deterministic safety layer in detail |
| `docs/MODES.md` | When to invoke each mode |
| `docs/LIFECYCLE.md` | State transitions and acceptance gates |
| `docs/FAILOVER.md` | Multi-tool session handoff (Claude Code → Codex → local) |
| `docs/VERIFICATION.md` | The proof-of-work protocol |
| `docs/MEMORY.md` | Two-tier memory: Stratum + file-based |
| `docs/COST_OPTIMIZATION.md` | Model routing, batching, brakes |
| `docs/OBSERVABILITY.md` | OTel + Langfuse + Laminar setup |
| `docs/SECURITY.md` | OWASP ASI 2026 threat model and defenses |
| `docs/EARS_GUIDE.md` | Writing testable specs |
| `docs/CLIENT_ONBOARDING.md` | Per-client setup checklist |
| `docs/GAP_61_COVERAGE_MATRIX.md` | Where each of the 61 design gaps is addressed |

---

## Status

DevOPs is on Phase 3 of a six-phase build (v0.2.0 shipped). See
`governance/VERSION.md` for the canonical phase table, `CHANGELOG.md` for
release history, and `governance/changelog/ROADMAP.md` for what's coming.

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | shipped (v0.1.0) | Foundation: constitution, hooks, core skills, analyzer, claim validator |
| 2 | shipped (v0.2.0) | Security depth: full pentest stack, OWASP ASI red-team integration, prompt-injection defense |
| 3 | **in progress** | Memory & observability: Stratum closeout (Option B locked), Langfuse, cross-project meta-memory |
| 4 | planned | Design phase skills: threat modeling, ADRs, OpenAPI-first, ERD, C4, perf/a11y budgets |
| 5 | planned | SRE & operate: SLOs, runbooks, incidents, cost attribution dashboards |
| 6 | planned | Self-improvement loop: telemetry-driven recommendations, skill self-evaluation |

---

## License

MIT
