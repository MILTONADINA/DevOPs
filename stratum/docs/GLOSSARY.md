# GLOSSARY.md — Project Terminology

A shared vocabulary for the CQ codebase. When in doubt about what a term means, this is the authoritative definition.

---

## Core Concepts

**Context Tax**
The portion of LLM API spend consumed by tokens that carry no semantic value for the current query — boilerplate, stale history, repetitive tool outputs, and redundant system prompts. Our thesis is that this represents approximately 80% of enterprise AI spend in long-running agent sessions.

**Context Quarantine**
The act of isolating and removing low-utility context before it reaches the LLM. The product name reflects this: we quarantine the noise so only the signal gets through.

**AI Slop**
Degraded LLM output quality caused by excessive noise in the context window. The LLM produces plausible-sounding but inaccurate responses because the signal-to-noise ratio of its input is too low.

**Compaction Degradation**
The progressive loss of factual accuracy that occurs when an AI system compresses session history through repeated summarization. Each summarization cycle introduces lossy compression; summaries of summaries drift exponentially from the Ground Truth.

**Ground Truth**
The actual, verifiable state of the codebase, infrastructure, or decisions at a given point in time. For CQ, Ground Truth is established by Git commit history and structured fact extraction, not AI-generated summaries.

**Memory Drift**
The divergence between what CQ's memory system believes to be true and what is actually true (as established by Ground Truth). The audit engine detects and suppresses memory drift.

**Historical Drift**
A specific, detected instance of memory drift: a stored fact that conflicts with the Git commit history. Triggers a "Historical Drift Detected" alert.

---

## Algorithm Terms

**KadaneDial**
The algorithm from the DyCP paper (arXiv:2601.07994) that extends Kadane's maximum subarray algorithm to identify contiguous spans of high-relevance dialogue turns. The name combines "Kadane" (the original algorithm's inventor, Joseph Kadane) and "dial" (dialogue).

**CQ-Extended KadaneDial**
CQ's proprietary extension of KadaneDial that adds a temporal decay factor λ. Turns that are semantically similar to the query but temporally distant are penalized. This is our algorithmic contribution beyond the DyCP paper.

**Temporal Decay Factor (λ)**
A scalar between 0 and 1 that controls how quickly older context loses relevance weight. Applied per elapsed hour: `λ^(elapsed_hours)`. At λ=0.97, context from 24 hours ago retains approximately 47% of its weight.

**Gain Shift (g)**
A threshold parameter in KadaneDial that determines how relevant a turn must be to contribute positively to a span's cumulative sum. Turns with normalized score below g are treated as "negative gain" and break spans.

**Theta (θ)**
The minimum cumulative gain required for a span to be included in the output. Filters out low-confidence spans with many marginally-relevant turns.

**Semantic Span**
A contiguous block of dialogue turns identified by KadaneDial as having sustained relevance to the current query. The pruner retains selected semantic spans and discards everything else.

**Relevance Score (R_i)**
The score assigned to each historical turn by CQ-Extended KadaneDial: `R_i = cosine_similarity(turn_i, query) × λ^(elapsed_hours)`. Z-score normalized before span selection.

**Z-Score Normalization**
Standardization of relevance scores to zero mean and unit variance before KadaneDial span selection. Ensures the gain shift parameter g operates consistently across heterogeneous sessions.

---

## Memory System Terms

**Tier 1 / Hot Memory**
In-RAM storage of the last 2 hours of verbatim session turns. KadaneDial's primary input. Sub-millisecond retrieval.

**Tier 2 / Warm Memory**
Supabase (Postgres) storage of structured facts extracted from the last 30 days of session history. The key distinction: structured facts, not summaries.

**Tier 3 / Cold Memory**
Long-term storage of facts beyond 30 days, in two parallel systems: Pinecone for vector similarity search, Neo4j for deterministic graph queries. Covers 1 year or more.

**Structured Fact**
A schema-typed, strongly-typed record representing a discrete piece of information extracted from a session. Examples: `FunctionChange`, `TechDecision`, `PolicyUpdate`. Contrast with "lossy summary."

**Lossy Summary**
An AI-generated natural language summary of session history. Avoided entirely in CQ. Summaries introduce confabulation risk and cannot be verified against Ground Truth.

**Fact Extraction**
The process of parsing session turns and identifying discrete structured facts using a Llama 4-8B model with strict schema validation. Runs asynchronously, not on the critical path.

**Promotion**
The nightly process of moving structured facts older than 30 days from Tier 2 (Supabase) to Tier 3 (Pinecone + Neo4j).

**Knowledge Graph**
The Neo4j-based graph database in Tier 3 that stores entities (Functions, Commits, Decisions, Developers, Policies) and their relationships. Enables deterministic queries like "what is the current status of function X?"

---

## Security Terms

**ZK-Context**
Zero-Knowledge Context. CQ's security architecture whereby raw session context is encrypted on the client device and only decrypted inside a hardware-attested Trusted Execution Environment (TEE). CQ operators cannot read customer context.

**TEE (Trusted Execution Environment)**
AWS Nitro Enclaves — isolated compute environments with no persistent storage, no network access, and no operator access. Provides cryptographic proof (via attestation documents) that the code running inside is exactly the published CQ code.

**Attestation**
The process by which the client verifies the TEE's identity before transmitting a session key. The Nitro Enclave produces a signed attestation document containing PCR measurements (hashes of the enclave's code). The client verifies these against published values.

**PCR (Platform Configuration Register)**
Cryptographic measurements of the enclave's boot components, OS, and application code. Changing any line of enclave code changes its PCR values, making it detectable.

**Session Encryption Key (SEK)**
A per-session AES-256-GCM key derived from the customer's master key via HKDF-SHA256. Transmitted to the TEE encrypted with the enclave's public key. Used to decrypt the context payload inside the enclave.

**HKDF**
HMAC-based Key Derivation Function. Used to derive session-specific encryption keys from the customer's master key. Compromise of one session's key does not affect other sessions.

---

## Audit Terms

**Git-Attestation**
The process of cross-referencing a structured fact against the project's Git commit history. Returns CONFIRMED, UNVERIFIED, or CONFLICT.

**CONFIRMED**
A structured fact that is validated by the Git commit graph. A code-related fact for which a matching commit exists at the stated timestamp.

**UNVERIFIED**
A structured fact with no corresponding Git evidence — neither confirming nor contradicting. Injected into context with an explicit "UNVERIFIED" label.

**CONFLICT / Historical Drift**
A structured fact that contradicts the Git commit graph. Suppressed before it can be injected into context. Developer is alerted.

**Suppressed**
A structured fact marked `is_suppressed = true` — excluded from all future context injection. Either suppressed by the audit engine (CONFLICT) or manually by the developer.

**Escalation**
The audit engine's process of routing a fact to a more expensive model when confidence is insufficient. Tier 1: Git-attestation (free). Tier 2: Llama spot-check (cheap). Tier 3: Opus audit (expensive, rare).

---

## Business Terms

**Token Arbitrage**
CQ's revenue model: charge 20% of the difference between the customer's original token spend and their quarantined token spend. Revenue is perfectly correlated with value delivered.

**Token Delta**
`original_tokens - quarantined_tokens`. The number of tokens eliminated by pruning for a given request. The basis for the billing calculation.

**Context-to-Commit Ratio**
The developer-facing productivity metric: tokens consumed per meaningful code commit. Before CQ: ~50,000. After CQ: ~5,000 (target). This is the metric that resonates with engineering managers.

**Design Partner**
The first non-founder user of CQ — a Fractional CTO agency that provides real usage data and feedback in exchange for free access. Not a beta user; a co-builder.

**Fractional CTO Agency**
A small firm that provides CTO-level technical leadership to multiple startups simultaneously. The ideal first customer: high AI usage, multiple codebases, acute pain from context bleed.

**Context Bleed**
The problem where an AI agent working on Project A inadvertently carries context from Project B into its reasoning, producing incorrect or confusing outputs. Particularly acute for Fractional CTO agencies managing many repos.

**MRR (Monthly Recurring Revenue)**
Monthly revenue from subscription customers. CQ's target: $20k MRR by end of Year 1.

**ARR (Annual Recurring Revenue)**
MRR × 12. CQ's Year 1 target: ~$180k. Year 2 target: ~$1.9M.
