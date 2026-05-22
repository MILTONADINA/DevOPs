# DevOPs

> A self-configuring, verification-first DevOps workflow for AI coding agents.
> Works with Claude Code, Codex CLI, Cursor, Antigravity, Kiro, Gemini CLI, Copilot,
> Windsurf, and local LLMs via universal SKILL.md and AGENTS.md formats.

DevOPs is not a framework. It is an *operating system for coding agents* that ships
with a constitution, deterministic safety hooks, a per-project analyzer that
auto-configures itself to each new repo, cryptographically verified proof-of-work,
multi-tool session handoff, and a three-tier persistent memory backend.

It is built to deliver the full DevOps cycle — from a vague client brief through
spec, design, build, harden, launch, operate, evolve — autonomously where it can be
verified, and with explicit human checkpoints where it cannot.

---

## Why

Across 591 documented production agent failures (2023–2026), **88% trace to
infrastructure gaps, not model quality**. The failure modes are well-known:

| Rank | Failure mode | Share | Example incident |
|------|--------------|-------|------------------|
| 1 | Context Blindness | 31.6% | Agent forgets a decision made 50 turns ago |
| 2 | Rogue Actions | 30.3% | Amazon Kiro deleted a production AWS environment, 13h outage |
| 3 | Silent Degradation | 24.9% | Output quality drifts week-over-week, unnoticed |
| 4 | Memory Corruption | 8.1% | Persistent memory poisoned by adversarial input |
| 5 | Runaway Execution | 5.1% | Claude Code subagent burned 27M tokens in a 4.6h infinite loop |

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
                │  Memory: Stratum + Zep + file-based  │ ← Persistence
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
- Ask, don't assume
- Goal-driven loop
- Surgical edits (every changed line traces to user request)
- Karpathy guidelines (vendored from multica-ai/andrej-karpathy-skills)

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

### Memory (three-tier, all wired)
- **File-based** — `.workflow/memory/` git-committed durable facts (works today)
- **Stratum** — your own context-pruning proxy with structured fact tables, audit_conflicts, billing_records (Phase 0+1 ready, advanced phases incoming)
- **Zep** — semantic temporal memory via MCP (best temporal-reasoning benchmark in 2026)

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

```bash
# 1. Clone DevOPs (one-time)
git clone https://github.com/MILTONADINA/DevOPs.git ~/DevOPs

# 2. Install globally
cd ~/DevOPs && ./install.sh

# 3. In any new or existing project:
cd ~/my-project
~/DevOPs/scripts/analyze.sh        # detects stack, recommends config
~/DevOPs/scripts/init-project.sh   # installs the recommended config
```

After installation, every supported coding agent will pick up DevOPs automatically
the next time you open the project.

See `docs/PLAYBOOK.md` for the full operational guide.

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
| `docs/MEMORY.md` | Three-tier memory: Stratum + Zep + file-based |
| `docs/COST_OPTIMIZATION.md` | Model routing, batching, brakes |
| `docs/OBSERVABILITY.md` | OTel + Langfuse + Laminar setup |
| `docs/SECURITY.md` | OWASP ASI 2026 threat model and defenses |
| `docs/EARS_GUIDE.md` | Writing testable specs |
| `docs/CLIENT_ONBOARDING.md` | Per-client setup checklist |
| `docs/GAP_61_COVERAGE_MATRIX.md` | Where each of the 61 design gaps is addressed |

---

## Status

DevOPs is in Phase 1 of a six-phase build. See `CHANGELOG.md` for current
implementation status and `governance/changelog/ROADMAP.md` for what's coming.

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | **in progress** | Foundation: constitution, hooks, core skills, analyzer, claim validator |
| 2 | planned | Security depth: full pentest stack, OWASP ASI red-team integration, prompt-injection defense |
| 3 | planned | Memory & observability: Stratum integration, Langfuse, cross-project meta-memory |
| 4 | planned | Design phase skills: threat modeling, ADRs, OpenAPI-first, ERD, C4, perf/a11y budgets |
| 5 | planned | SRE & operate: SLOs, runbooks, incidents, cost attribution dashboards |
| 6 | planned | Self-improvement loop: telemetry-driven recommendations, skill self-evaluation |

---

## License

MIT
