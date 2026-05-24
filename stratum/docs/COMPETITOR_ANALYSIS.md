# COMPETITOR_ANALYSIS.md — Competitive Landscape

Last updated: April 2026

---

## Market Framing

The context management space has two categories of product:

**General-purpose AI memory** (Mem0, Zep, Letta/MemGPT, LangMem) — built for chatbots and conversational agents. They store "memories" as natural language summaries and retrieve them semantically. They are not built for developer tooling, do not verify against source of truth, and do not address the cost angle.

**Token optimization tools** (context window utilities, prompt compressors) — simple truncation or keyword filtering. They reduce tokens by cutting content, with no guarantee of preserving semantic relevance.

CQ occupies a distinct position: **version-controlled, developer-native, cost-aligned context infrastructure.** No existing product sits in this exact position.

---

## Competitor Table

| | **Mem0** | **Zep** | **Letta (MemGPT)** | **LangMem** | **opencode-dcp** | **CQ** |
|---|---|---|---|---|---|---|
| **Primary use case** | Chatbot memory | Enterprise agent memory | Research / general agents | LangChain agents | Single-session context | Developer AI infra |
| **Memory format** | NL summaries | Graph + NL | Paged memory (NL) | NL + structured | Keyword filter | Structured facts (typed) |
| **Ground truth verification** | None | None | None | None | None | Git-attestation |
| **Temporal decay** | None | None | None | None | None | λ-decay (CQ-Extended KadaneDial) |
| **ZK-Context / encryption** | No | No | No | No | No | Yes (TEE + AES-256-GCM) |
| **Token cost reduction** | Marginal | Marginal | No | Marginal | Yes (local only) | Yes (measurable, billed on savings) |
| **Business model** | SaaS seats | SaaS seats | Open source | Open source | Open source plugin | 20% of savings |
| **Dev tooling native** | No | Partial | No | No | Yes (Claude Code) | Yes (Claude Code first) |
| **Cross-session memory** | Yes | Yes | Yes | Yes | No | Yes |
| **Compliance / SOC2 target** | In progress | Yes | No | No | No | Designed-in |
| **Pricing** | $499/mo+ | $500/mo+ | Free | Free | Free | 20% of savings |

---

## Detailed Competitor Profiles

### Mem0

**What it is:** An AI memory layer that extracts "memories" from conversations and stores them as natural language facts. Retrieves relevant memories at query time.

**Strengths:** Clean SDK, easy integration, growing developer adoption, well-funded.

**Weaknesses:**
- Memories are LLM-generated summaries — subject to confabulation
- No verification against any source of truth
- No cost reduction mechanism — does not reduce tokens sent to the LLM
- General-purpose: not optimized for developer/code tooling
- Business model requires the customer to trust them with all conversation data

**Why CQ wins:**
- Structured fact extraction vs. summaries → no confabulation
- Git-attestation → Ground Truth verification Mem0 cannot offer
- 20% of savings model → Mem0 costs money regardless of value delivered
- ZK-Context → enterprise security story Mem0 lacks

---

### Zep

**What it is:** Enterprise-grade memory for AI agents. Uses a graph + natural language hybrid. Targets enterprise buyers with SOC2.

**Strengths:** SOC2 compliant, enterprise sales motion, graph-based memory is directionally right, good API design.

**Weaknesses:**
- Memory still ultimately NL-based, not typed structured facts
- No token cost reduction (memory retrieval adds tokens, doesn't subtract them)
- Expensive ($500+/mo) and seat-based
- Not developer-tooling native — general agent focus
- No temporal decay — stale memories surface equally with recent ones

**Why CQ wins:**
- Typed structured facts vs. NL graph → more verifiable, less confabulation
- Token arbitrage model → Zep costs $500+ flat; CQ only bills when it saves money
- KadaneDial temporal decay → old context de-prioritized correctly
- Git-attestation → code-specific Ground Truth Zep has no equivalent of

---

### Letta (MemGPT)

**What it is:** Academic/research project that treats LLM context as a paged memory system. Open source.

**Strengths:** Innovative architecture, strong research credibility, active community.

**Weaknesses:**
- No production SLA or enterprise support
- Paged memory is NL-based — confabulation risk
- No token cost reduction as a product goal
- Research-grade, not production-grade

**Why CQ wins:**
- Production-grade from day one
- Token arbitrage model (commercial)
- Git-attestation (no research equivalent)
- ZK-Context (security story Letta has not addressed)

---

### LangMem (LangChain)

**What it is:** LangChain's official memory layer. Tight integration with LangChain/LangGraph ecosystem.

**Strengths:** First-party LangChain integration, large existing user base, free.

**Weaknesses:**
- LangChain ecosystem lock-in — poor for Claude Code / non-LangChain agents
- NL-based memory with same confabulation risks
- No cost reduction focus
- Free = no commercial alignment with customer success

**Why CQ wins:**
- Model-agnostic proxy — works with any agent that calls the Anthropic API
- Commercial alignment (we only make money when customers save money)
- Structured fact extraction
- Developer-native tooling focus

---

### opencode-dynamic-context-pruning (GitHub)

**What it is:** Open source plugin for OpenCode (a Claude Code competitor) that implements basic dynamic context pruning. Created April 2026.

**Strengths:** First-mover on DyCP implementation, open source (free), developer-sympathetic.

**Weaknesses:**
- Single session, single editor — no cross-session memory
- No structured fact extraction
- No billing model (open source)
- No ZK-Context
- No Git-attestation
- No cross-project memory (Context Bleed problem is unsolved)
- Plugin, not infrastructure

**Why CQ wins:**
- "They built a feature. We're building infrastructure."
- Cross-session, cross-project memory
- Commercial model (sustainable)
- Enterprise security story
- Git-attestation for code Ground Truth
- Full tiered memory architecture

---

## Our Differentiated Position

CQ is the only product that combines all four of:

1. **Semantic pruning** (KadaneDial, not keyword filtering)
2. **Ground Truth verification** (Git-attestation — no competitor has this)
3. **Cost-aligned business model** (20% of savings — not flat SaaS)
4. **Enterprise security** (ZK-Context + TEE — no competitor has this)

Any one of these is a differentiator. All four together is a moat.

---

## Monitoring Competitors

Check monthly:
- Mem0 product updates: mem0.ai/blog
- Zep releases: github.com/getzep/zep
- LangMem releases: github.com/langchain-ai/langmem
- opencode-dcp: github.com/Opencode-DCP/opencode-dynamic-context-pruning
- arXiv:cs.CL new papers on context management and pruning

Significant competitor moves worth an ADR-level response:
- Any competitor announces Git-based memory verification
- Any competitor announces TEE/ZK-Context
- Any competitor pivots to token-savings pricing model
- A major cloud provider (AWS, Azure, Google) announces a native context management product
