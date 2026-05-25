# ADR-0006: Dual Cold Storage — Pinecone (Vector) + Neo4j (Graph)

**Date:** 2026-04-06
**Status:** Accepted

## Context

Tier 3 Cold Memory needs to handle two fundamentally different query types:

1. **Fuzzy semantic retrieval** — "find facts semantically similar to the current query" — a vector similarity problem
2. **Deterministic entity lookup** — "what is the current status of function X?" or "what decisions apply to project Y?" — a graph traversal problem

These are not the same problem and no single database handles both well.

## Decision

Use two parallel stores for Tier 3: Pinecone for vector similarity search, Neo4j AuraDB for knowledge graph traversal. Every Cold Memory fact is written to both stores during promotion.

## Consequences

- Two stores to maintain, two clients to integrate, two failure modes to handle
- Nightly promotion job must write to both successfully or roll back
- Query logic must decide which store to hit for which query type (deterministic lookup → Neo4j; semantic search → Pinecone)
- Cost: both are managed services with usage-based pricing — this is acceptable at our scale
- If either store is unavailable, the system degrades gracefully (falls back to Tier 2 only)
- The combination enables the "50 tokens for a graph query vs. 50,000 tokens of raw history" pitch point — this is architecturally load-bearing for the business case

## Alternatives Considered

**Pinecone only (vector only):** Rejected because vector similarity cannot answer deterministic questions. "What is the current status of function getUser()?" requires a traversal of relationships (DEPRECATED_BY, REFERENCED_IN). Approximate nearest-neighbor search on that question would return plausible but unverifiable results — exactly the hallucination risk we're trying to eliminate.

**Neo4j only (graph only):** Rejected because graph traversal requires structured queries with known entity names. "Find facts related to the current query about async error handling" is not a graph query — it's a semantic similarity search. Neo4j has vector index support, but it is secondary to its graph capabilities and not as performant or cost-effective for high-throughput vector search as Pinecone.

**pgvector (Postgres vector extension in Supabase):** Rejected for Tier 3 because Supabase is already load-bearing for Tier 2 structured facts. Adding 1+ year of vector embeddings to the same Postgres instance creates an operational risk. Pinecone is purpose-built and horizontally scalable for this use case.

**Weaviate or Qdrant (all-in-one vector + structured):** Rejected because neither provides Neo4j-grade graph traversal with Cypher query language. The graph traversal capability (MATCH, OPTIONAL MATCH, relationship chains) is essential for the Git-attestation queries that define our competitive advantage.
