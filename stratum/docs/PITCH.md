# PITCH.md — Investor Brief

> One-page narrative for seed-stage conversations. Not a slide deck — a thinking document.

---

## The Headline

**Startum eliminates the AI Context Tax — the ~80% of enterprise LLM spend consumed by noise — and charges 20% of what it saves. Customers get better AI for half the price. We get paid only when they do.**

---

## The Problem (Why Now)

The Long Context arms race of 2024–2025 failed the enterprise. Models now support 1M+ tokens. Nobody asked for that. What they got instead:

- **The Context Tax:** Development teams at AI-heavy companies spend 80% of their API budget on boilerplate, stale history, and repetitive tool outputs that have no bearing on the current query.
- **Memory Drift:** As sessions grow over months, AI systems suffer "Compaction Degradation" — summaries of summaries diverge from what was actually decided and built. The AI confidently hallucinates your own codebase back at you.
- **Latency Slop:** 1M-token windows push response times from <2s to >30s. Developer productivity craters.

This is not a fringe problem. Every company with AI-assisted development is paying this tax today.

---

## The Solution

CQ is a deterministic middleware proxy that sits between AI agents (Claude Code, AutoGPT, custom agents) and the LLM API. It does three things:

**1. Prune.** The CQ-Extended KadaneDial algorithm (extending DyCP, arXiv:2601.07994) identifies contiguous "high-relevance spans" in session history using semantic similarity with a temporal decay factor. Irrelevant context is quarantined. Only signal reaches the LLM.

**2. Remember correctly.** History is stored as typed structured facts (FunctionChange, TechDecision, PolicyUpdate) — not lossy summaries. Every code-related memory is cross-referenced against Git commit history before injection. If the AI's memory conflicts with what was actually committed, CQ suppresses it and alerts the developer.

**3. Protect.** The ZK-Context architecture ensures raw customer context is encrypted client-side and only decrypted inside an AWS Nitro Enclave (TEE). Even CQ operators cannot read customer data. The attestation is cryptographically verifiable.

---

## Business Model

```
Revenue = 20% × (Original Token Cost − Quarantined Token Cost)
```

This is Token Arbitrage. We charge for savings, not seats. Customers never pay more than they save. Our incentives are perfectly aligned with theirs.

**Unit economics for a 10-developer engineering team:**
- Before CQ: $15,000/month in Anthropic API costs
- After CQ: $2,250/month (85% pruning effectiveness)
- Savings: $12,750/month
- CQ fee: $2,550/month
- Customer nets: $10,200/month in savings

Gross margin: ~90%. COGS is primarily compute for the ONNX pruning model and Llama fact extraction — both cheap.

---

## Traction

- Phase 0 complete: real session data captured and analyzed
- Design partner: [to be filled after M1] — Fractional CTO agency, $X/month API spend, running on CQ proxy for N weeks
- Context-to-Commit Ratio: 50,000 tokens/commit → 5,000 tokens/commit (10× improvement, maintained code quality)
- Eval suite: 92% Faithfulness, 89% Answer Relevancy vs. full-context baseline

---

## Market

**Bottom-up TAM:**
- 5M developers using AI coding assistants as of Q1 2026
- Average $200/month in API costs per developer
- At 85% waste rate: $170/month in wasteable spend per developer
- CQ captures 20% of that: $34/month per developer at 100% penetration
- TAM: $170M/month = **$2B ARR at full penetration** (developer segment alone)

Enterprise segment is larger. A company with 100 AI-using developers spending $500k/year on APIs could save $400k and pay CQ $80k — a straightforward procurement decision.

---

## Why We Win

| | Competitors (Mem0, Zep, LangMem) | CQ |
|---|---|---|
| Memory format | NL summaries (lossy) | Typed structured facts |
| Ground Truth | None | Git-attestation |
| Token cost reduction | None | Core value prop |
| Business model | Flat SaaS seats | 20% of savings |
| Enterprise security | Basic | ZK-Context + TEE |
| Developer tooling native | No | Yes (Claude Code first) |

The combination of all four differentiators (semantic pruning + Git verification + cost-aligned pricing + ZK-Context) is not replicable quickly. Each requires deep technical investment.

---

## The Team

**[Your name]** — Founder. Computer Science + Cybersecurity. [Your university/background]. Deep understanding of both the technical problem (context management, cryptography) and the business model (token economics). Built the initial proxy and eval framework.

---

## Ask

Raising $[X] pre-seed to:
- Hire one senior engineer (TypeScript + Rust)
- Reach Phase 4 (ZK-Context + TEE) in 8 months
- Sign 5 paying enterprise customers before the seed round
- Target: $50k MRR by month 12

---

## Contact

[your@email.com]
[github.com/your-org/startum]

---

*This document is confidential and intended for prospective investors only.*
