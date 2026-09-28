# ADR-0004: Prohibit LLM Summarization for Memory Compression

**Date:** 2026-04-06
**Status:** Accepted

## Context

The obvious approach to long-term memory is to ask an LLM to summarize older context: "Summarize the last 100 messages in 500 tokens." Every existing memory product (Mem0, Zep, MemGPT) does some version of this.

## Decision

LLM summarization is prohibited for memory compression in CQ at any tier. All long-term memory is stored as schema-typed structured facts extracted via a schema-constrained Llama call, not as natural language summaries.

## Consequences

- Fact extraction is harder to implement than summarization (requires schemas, Zod validation, extractor prompts)
- Some information that doesn't fit a schema is discarded rather than summarized — this is acceptable and intentional
- Retrieval from Tier 2/3 returns structured JSON, not prose
- The AI receiving injected memory gets typed data, not a narrative — this requires prompt engineering to handle well
- Hallucination on hallucination loops are prevented by construction

## Alternatives Considered

**LLM summarization (standard approach):** Ask Opus/GPT-4 to "summarize the last N turns." Rejected for three reasons: (1) Each summarization cycle is lossy. Summaries of summaries drift exponentially — after 12 months of nightly summarization, the summary bears little resemblance to what was actually decided. (2) Summaries cannot be verified against Ground Truth. A summary that says "we decided to use AWS" cannot be cross-checked against Git history. (3) Summaries can confabulate with confidence. Structured facts can be wrong, but they cannot be "vaguely right" in a way that sounds authoritative.

**Hybrid (summarize + extract):** Summarize for prose context, extract for code-related facts. Rejected because it reintroduces the confabulation problem for the summarized portion and adds implementation complexity without sufficient benefit.
