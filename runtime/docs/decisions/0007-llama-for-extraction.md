# ADR-0007: Llama 4-8B for Fact Extraction (Not Claude Opus)

**Date:** 2026-04-06
**Status:** Accepted

## Context

Structured fact extraction runs on every session turn evicted from Tier 1 Hot Memory — approximately once per turn in active sessions. At scale, this is the highest-volume AI call in the system. The extraction task is constrained: produce a valid JSON object matching a known schema, or return null. The task does not require broad reasoning, nuance, or long-form generation.

## Decision

Use Llama 4-8B (via a managed inference endpoint such as Together AI or Groq) for all Tier 1 → Tier 2 fact extraction. Claude Opus is reserved for the Tier 3 audit escalation path only, triggered when Llama confidence is < 0.85 (target: < 1% of extractions).

## Consequences

- Cost: Llama 4-8B inference is approximately $0.0005–0.001 per extraction vs. $0.01–0.02 for Opus — a 10–40× cost difference that makes the extraction pipeline economically viable
- Extraction must be schema-constrained with Zod validation — Llama's output is validated before any DB write. Invalid outputs are discarded, not retried
- Confidence calibration: Llama returns a confidence score with each extraction. We must validate this score is well-calibrated against our fact types before relying on the 0.85 escalation threshold
- Inference provider dependency: we depend on Llama availability via a third-party API. Monitor for latency spikes. The extraction job is async and can tolerate 2–5s inference latency
- The extraction prompt must be carefully engineered: the model must return only valid JSON, no preamble, no explanation. Test this thoroughly before production

## Alternatives Considered

**Claude Opus for all extractions:** Rejected because at $0.01–0.02 per extraction and thousands of extractions per day per organization, the cost exceeds our 20% arbitrage revenue. Extraction must be cheap enough to be invisible in unit economics. Opus is too expensive for a high-frequency background task.

**Claude Haiku for extractions:** A reasonable middle ground. Haiku is cheaper than Opus and more reliable than Llama on structured output tasks. Not rejected definitively — if Llama calibration proves difficult, Haiku is the fallback. For now we start with Llama to maximize gross margin.

**Rule-based extraction (regex / AST parsing):** Rejected because the diversity of developer dialogue makes exhaustive rule-based extraction impractical. Developers describe code changes in too many ways for regex to be reliable. ML extraction with schema validation is the right trade-off.

**GPT-4o-mini:** Rejected for cost and vendor concentration. We already depend on Anthropic for the primary LLM call. Adding OpenAI as a second critical dependency for extraction creates vendor risk. An open-source model via managed inference is preferable.
