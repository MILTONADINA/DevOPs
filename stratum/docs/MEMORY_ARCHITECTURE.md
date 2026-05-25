# MEMORY_ARCHITECTURE.md — Three-Tier Memory System

## Overview

CQ's memory system solves one core problem: how do you maintain a year of AI session history without either (a) bloating context windows or (b) losing the Ground Truth through lossy summarization?

The answer is three distinct storage tiers with different retention policies, formats, and retrieval mechanisms. The key insight is that **each tier stores information in a different fidelity format**, not just at a different time horizon.

---

## Design Principle: Facts, Not Summaries

We never ask an LLM to summarize history. Summaries introduce lossy compression, confabulation, and compounding errors ("summaries of summaries").

Instead, each exchange is processed by a schema-based extractor that identifies structured facts:

```typescript
// We DO NOT do this:
const summary = await llm("Summarize the last 100 messages");

// We DO this:
const facts = extractStructuredFacts(exchange);
// → { type: "FunctionDeprecation", old: "getUser", new: "fetchUser", commit: "a3f9..." }
// → { type: "PolicyUpdate", policy: "auth", change: "JWT → OAuth2", timestamp: ... }
// → { type: "TechDecision", decision: "Move to Supabase from PlanetScale", date: ... }
```

Structured facts are hard data points. They can be wrong (and the audit engine catches that), but they cannot be "vaguely right" the way summaries can be.

---

## Tier 1 — Hot Memory (RAM)

**What:** Last 2 hours of raw, verbatim dialogue turns.

**Where:** In-process memory (Durable Object state or client-side `Map`).

**Format:** Raw turn objects — exactly as received from the LLM API.

**Retention:** Rolling 2-hour window. Oldest turns evicted first.

**Access:** Synchronous. This is the KadaneDial input. Retrieval must be sub-millisecond.

**Schema:**
```typescript
interface HotTurn {
  id: string;                // uuid
  session_id: string;        // uuid
  timestamp: number;         // Unix ms
  role: "user" | "assistant";
  content: string;           // verbatim
  token_count: number;       // exact, Anthropic tokenizer
  embedding: Float32Array;   // 384-dim, computed on receipt
}
```

**Eviction policy:** When a turn's `timestamp` is older than `now - 7200000ms` (2 hours), it is evicted from RAM and written to Tier 2 for extraction. The raw verbatim content is NOT stored in Tier 2 — only the extracted structured facts.

---

## Tier 2 — Warm Memory (Supabase)

**What:** Last 30 days of structured facts extracted from session history.

**Where:** Supabase (Postgres), hosted.

**Format:** Typed structured fact records. Not summaries. Not raw text.

**Retention:** 30 days. After 30 days, facts are promoted to Tier 3 (vector + graph).

**Access:** Async, ~5–50ms depending on query complexity.

### Fact Types

All fact tables share a common base:

```sql
-- Base columns present on every fact table
id              uuid primary key default gen_random_uuid()
created_at      timestamptz not null default now()
session_id      uuid not null references sessions(id)
developer_id    uuid references developers(id)
commit_hash     text           -- null if not code-related
confidence      float not null -- 0.0 to 1.0, from extraction model
is_verified     boolean default false  -- set true after Git-attestation
is_suppressed   boolean default false  -- set true if audit finds conflict
```

**`function_changes`** — tracks function renames, deprecations, signature changes:
```sql
old_name        text not null
new_name        text
change_type     text not null  -- 'deprecated' | 'renamed' | 'signature_changed'
file_path       text
language        text
```

**`tech_decisions`** — architectural and tooling decisions:
```sql
decision_text   text not null   -- "Moved from PlanetScale to Supabase"
domain          text            -- 'database' | 'auth' | 'deployment' | etc.
rationale       text
supersedes_id   uuid references tech_decisions(id)
```

**`policy_updates`** — security, compliance, process policy changes:
```sql
policy_name     text not null
old_value       text
new_value       text not null
policy_type     text            -- 'security' | 'compliance' | 'process'
effective_date  date
```

**`todos`** — explicit commitments recorded in sessions:
```sql
description     text not null
status          text default 'open'   -- 'open' | 'done' | 'cancelled'
due_date        date
assigned_to     uuid references developers(id)
```

**`variable_changes`** — environment variable and config changes:
```sql
var_name        text not null
old_value       text           -- may be null for new vars
new_value       text
context         text           -- which service/project this applies to
```

### Extraction Pipeline

Extraction runs asynchronously after each session turn, not on the critical path:

```
Turn evicted from Tier 1
        │
        ▼
Extraction Worker (Llama 4-8B)
  Prompt: "Extract structured facts from this exchange. 
           Output JSON matching one of: FunctionChange, TechDecision, 
           PolicyUpdate, Todo, VariableChange, or null.
           Be conservative — return null if unsure."
        │
        ▼
Schema validation (Zod)
        │
        ├── Valid → write to fact table with confidence score
        └── Invalid → log and discard (do not write garbage)
```

**Never use GPT-4 or Opus for extraction.** This runs on every turn — it must be cheap. Llama 4-8B at <1¢ per extraction is acceptable. Opus at 10× the cost is not.

---

## Tier 3 — Cold Memory (Pinecone + Neo4j)

**What:** Full history beyond 30 days, stored in two parallel systems for different query types.

**Where:** Pinecone (vector similarity search) + Neo4j (graph traversal).

**Format:** Pinecone stores embeddings of fact text for fuzzy semantic search. Neo4j stores the structured relationships between entities for deterministic queries.

**Retention:** 1 year minimum. Enterprise customers may configure longer.

**Access:** Async, 50–200ms. Only queried when Tier 1 and Tier 2 are insufficient.

### Pinecone Schema

Each Pinecone vector represents one structured fact:

```
id:        "{fact_type}:{fact_id}"
embedding: float[1536]   # ada-002 or equivalent, re-encoded for long-term storage
metadata:
  fact_type:    string
  session_id:   string
  created_at:   ISO8601
  commit_hash:  string | null
  confidence:   float
  is_verified:  boolean
  text:         string   # human-readable summary of the fact (for display, NOT for context injection)
```

**The text field in metadata is for display only.** When a Tier 3 fact is retrieved for context injection, the system injects the structured fact JSON, not the metadata text field. This preserves fidelity.

### Neo4j Schema

Neo4j stores the knowledge graph for deterministic queries like "what is the current status of function X?"

**Node types:**
```cypher
(:Function {name: string, language: string, file_path: string, status: string})
(:Commit   {hash: string, message: string, timestamp: int, author: string})
(:Decision {id: uuid, domain: string, text: string, date: date})
(:Developer{id: uuid, name: string})
(:Policy   {name: string, domain: string, effective_date: date})
(:Project  {id: uuid, name: string, repo_url: string})
```

**Edge types:**
```cypher
(Function)-[:DEPRECATED_BY {at: timestamp}]->(Function)
(Function)-[:REFERENCED_IN {line: int}]->(Commit)
(Decision)-[:SUPERCEDES]->(Decision)
(Decision)-[:APPLIES_TO]->(Project)
(Developer)-[:AUTHORED]->(Commit)
(Commit)-[:MODIFIES]->(Function)
(Policy)-[:GOVERNS]->(Project)
```

**Example query — "What is the current status of getUser()?"**
```cypher
MATCH (f:Function {name: 'getUser'})
OPTIONAL MATCH (f)-[:DEPRECATED_BY]->(replacement:Function)
RETURN f.status, replacement.name, replacement.status
```

This query costs ~50 tokens of context injection vs. reading 11 months of logs.

### Promotion Pipeline (Tier 2 → Tier 3)

Every night at 02:00 UTC:

```
1. Query Supabase for facts older than 30 days
2. For each fact:
   a. Encode fact text to embedding (ada-002 equivalent)
   b. Upsert into Pinecone with metadata
   c. Upsert into Neo4j as typed nodes and edges
   d. Mark Supabase record as promoted (do not delete — keep for audit trail)
3. Log promotion run results
```

---

## Memory Retrieval Flow

When a new query arrives and Tier 1 alone is insufficient:

```
1. KadaneDial runs on Tier 1 turns
2. If < MIN_CONTEXT_TURNS selected from Tier 1:
   a. Query Tier 2: SELECT facts WHERE similarity(embedding, query_emb) > 0.75
                    ORDER BY confidence DESC, created_at DESC LIMIT 20
   b. For each Tier 2 fact: if code-related, run Git-attestation
   c. Inject verified facts as structured JSON into context
3. If query references specific functions, decisions, or policies:
   a. Query Neo4j for current status of those entities
   b. Inject deterministic graph results (zero hallucination risk)
4. If still insufficient (rare):
   a. Query Pinecone for semantically similar Tier 3 facts
   b. Apply same Git-attestation + injection pipeline
```

---

## Memory Write Performance Budget

These are the targets. Exceed them only with a documented ADR:

| Operation | Target latency | Acceptable max |
|---|---|---|
| Tier 1 embedding (ONNX) | < 10ms | 15ms |
| Tier 1 KadaneDial | < 2ms | 5ms |
| Tier 2 fact read (Supabase) | < 30ms | 80ms |
| Tier 3 vector search (Pinecone) | < 100ms | 200ms |
| Tier 3 graph query (Neo4j) | < 50ms | 100ms |
| Fact extraction (Llama, async) | < 2s | 5s |
| Nightly promotion job | < 30min | 2hr |
