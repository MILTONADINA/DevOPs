# BUSINESS_MODEL.md — Token Arbitrage and Pricing

## The Core Model

```
Revenue = 20% × (Original_Token_Cost − Quarantined_Token_Cost)
```

The customer never pays more than they save. If we fail to prune effectively, we make no money. Our incentives are perfectly aligned with the customer's.

---

## Why This Model Wins

### Traditional SaaS (seats / per-month)

- Customer pays $500/month regardless of value delivered
- If the product doesn't save them money, they churn
- Sales conversation is about trust and promises

### Token Arbitrage

- Customer pays $0 if savings are $0
- Customer pays $2,000 if savings are $10,000 (they net $8,000)
- Sales conversation is: "Here is your waste report. Here is what you'll pay us."
- No trust required — the math is self-evident

This is the model. Do not complicate it.

---

## The Math in Practice

### Scenario: Fractional CTO Agency (Design Partner Target)

| Metric | Current | With CQ |
|---|---|---|
| Developers | 3 | 3 |
| Claude Code sessions/day | 20 | 20 |
| Avg tokens per session (original) | 50,000 | — |
| Avg tokens per session (quarantined) | — | 7,500 |
| Token price (Claude Opus input) | $0.000015/token | $0.000015/token |
| Monthly original cost | $4,500 | — |
| Monthly quarantined cost | — | $675 |
| Monthly savings | — | $3,825 |
| CQ fee (20%) | — | $765 |
| Net savings to customer | — | $3,060 |

**Their ROI: 400%.** They pay us $765 and keep $3,060 they would have wasted.

### Scenario: Mid-size Engineering Team (10 developers)

| Metric | Value |
|---|---|
| Monthly original API spend | $15,000 |
| Pruning effectiveness | 85% |
| Monthly quarantined cost | $2,250 |
| Monthly savings | $12,750 |
| CQ fee (20%) | $2,550 |
| Net savings to customer | $10,200 |

**MRR from one customer: $2,550.**

---

## Pricing Tiers

Pricing is not per-seat. It is a percentage of savings, with a monthly minimum:

| Tier | Monthly minimum | Arbitrage rate | Target customer |
|---|---|---|---|
| Starter | $0 | 20% | Individual developers, students |
| Growth | $99/month | 20% | Small agencies (2–10 devs) |
| Enterprise | $499/month | 20% | Engineering teams (10+ devs) |
| Custom | Negotiated | 15–20% | Enterprises with $50k+/month AI spend |

The monthly minimum protects CQ from very-low-usage customers where the operational cost exceeds revenue. Below the minimum, the customer pays the minimum. Above it, they pay 20% of savings.

### Enterprise Add-Ons (flat monthly fee)

| Feature | Price |
|---|---|
| ZK-Context (TEE encryption) | +$299/month |
| Git-Attestation (code memory) | +$199/month |
| SSO / SAML | +$149/month |
| Dedicated infrastructure | Custom |
| SLA (99.9% uptime guarantee) | +$249/month |

---

## Revenue Projections

### Year 1 (Conservative)

| Quarter | Customers | Avg MRR/customer | MRR |
|---|---|---|---|
| Q1 | 1 (design partner, free) | $0 | $0 |
| Q2 | 5 Growth | $300 | $1,500 |
| Q3 | 15 Growth + 2 Enterprise | $500 avg | $8,500 |
| Q4 | 30 Growth + 8 Enterprise | $600 avg | $22,800 |

**Year 1 ARR target: ~$180,000**

### Year 2 (Target)

| Segment | Customers | Avg MRR | MRR |
|---|---|---|---|
| Growth | 150 | $400 | $60,000 |
| Enterprise | 30 | $2,500 | $75,000 |
| Custom | 3 | $8,000 | $24,000 |

**Year 2 ARR target: ~$1,900,000**

---

## Unit Economics

### Cost of Goods Sold (COGS) per $1 of CQ revenue

| Cost item | % of revenue |
|---|---|
| Anthropic API (Llama extraction) | ~2% |
| Anthropic API (Opus escalation) | <2% |
| Cloudflare Workers + bandwidth | ~1% |
| Supabase (Postgres) | ~1% |
| Pinecone | ~1% |
| Neo4j AuraDB | ~1% |
| AWS Nitro Enclaves | ~2% |
| **Total COGS** | **~10%** |

**Gross margin: ~90%**

This is exceptional for a software business. The arbitrage model means we grow revenue by serving customers better, not by adding servers.

---

## The CFO Dashboard

The token arbitrage model requires a CFO-grade billing artifact. Every month, customers receive:

1. **Waste Report** — original token spend breakdown by project, by developer, by session type
2. **Savings Report** — quarantined token spend vs. original, pruning effectiveness %
3. **Invoice** — 20% of savings delta, with itemized line items per session
4. **Audit Trail** — downloadable CSV of every billing record with signed hashes

The audit trail is the most important artifact. If a customer disputes a savings claim, they need to be able to verify every number independently. The signed HMAC on each billing record ensures we cannot retroactively modify the data.

---

## What "Better AI" Means for the Pitch

The token arbitrage pitch has two parts:

1. **Cost:** You pay 50% of what you paid before. (The math above.)
2. **Quality:** The AI is more accurate because it has less noise.

Part 2 is harder to quantify but more emotionally compelling. The right framing:

> "Your AI was hallucinating because it was drowning in 50,000 tokens of context it didn't need. We cut that to 5,000 tokens of exactly what's relevant. Your developers get faster responses, fewer wrong answers, and the AI actually remembers decisions from three months ago — because we store them as facts, not fuzzy summaries."

The "Context-to-Commit Ratio" is the developer-facing metric:
- Before CQ: 50,000 tokens per bug fix
- After CQ: 5,000 tokens per bug fix, same code quality

Measure this with your design partner in Phase 1. That number is your sales deck.
