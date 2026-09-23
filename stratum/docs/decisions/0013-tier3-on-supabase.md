# ADR-0013: Tier-3 Cold Memory on Supabase (deviation from Neo4j + Pinecone)

**Date:** 2026-05-29
**Status:** Accepted (user-approved 2026-05-29 — explicit deviation from the locked blueprint)

## Context

Tier-3 cold memory (per `MEMORY_ARCHITECTURE.md` + stratum CLAUDE.md) is specified
as **Neo4j** (knowledge graph) + **Pinecone** (vector store). Both are paid managed
services; neither an account nor an MCP connection is available in this environment,
so `src/memory/cold/{neo4j,pinecone}.ts` have stood as stubs.

A **live Supabase project** (`Stratum`, used for Tier-2) *is* available, and Postgres
can serve both roles: relational tables for the graph, and the `pgvector` extension
for vectors. The blueprint's Neo4j/Pinecone choice was "locked" (Option B), so
switching the Tier-3 datastore is a revisit-the-locked-decision call — it was put to
the user, who approved **building Tier-3 on Supabase now**, behind a swappable
interface.

The immediate driver is the **ADR-0011 pruner fix**: its primary option suppresses a
superseded turn when a `SUPERSEDES` edge exists in the graph. Without *any* Tier-3
graph, that fix cannot be implemented or validated. Supabase unblocks it today.

## Decision

Implement Tier-3 on the live Supabase project, behind interfaces that a future
Neo4j/Pinecone adapter implements unchanged:

1. **Graph (this increment).** `knowledge_entities` + `knowledge_edges` tables
   (migration `20260529120000_tier3_knowledge_graph.sql`) + a `find_superseded(org,
   names[])` SQL function. `src/memory/cold/graph.ts` exposes the
   `KnowledgeGraph` interface (`ensureEntity` / `addEdge` / `findSuperseded`); the
   Supabase implementation is `createKnowledgeGraph(client)`. `findSuperseded` is the
   ADR-0011 query. Verified live via the Supabase MCP (entities + a SUPERSEDES edge +
   the supersession query) + unit-tested against a fake client.
2. **Vectors (done — migration `20260529130000_tier3_vectors.sql`).** The `pgvector`
   extension + a `memory_vectors` table (384-d, matching the all-MiniLM-L6-v2 encoder;
   HNSW + cosine ops) + a `match_memory_vectors` similarity function, behind the
   `VectorStore` interface (`src/memory/cold/vectors.ts`). Serves the semantic-recall /
   `/understand-codebase` path Pinecone was specified for. **Content-free** (embedding +
   `source_type`/`source_ref` pointer only — no plaintext content, per the "encrypted
   only" rule). Verified live via MCP (orthogonal 384-d vectors → cosine ranking
   1.0/0.0) + unit-tested. The `VectorStore` seam is what a Pinecone adapter implements.

**Spelling:** CLAUDE.md writes the edge `SUPERCEDES`; this standardizes on the correct
English **`SUPERSEDES`**, consistent with `tech_decisions.supersedes_id` + ADR-0011.

## Consequences

- **Unblocks** the ADR-0011 supersession fix + the v0.5.x `/understand-codebase` path
  **without a paid account** — using infrastructure already provisioned.
- **Swap path stays open.** The pruner + recall consume the `KnowledgeGraph` /
  `VectorStore` interfaces, not Postgres. Moving to Neo4j/Pinecone later means writing
  one adapter each against the same interface; no consumer changes. The migrations +
  ADR make the deviation explicit and reversible.
- **Known limitation.** Postgres handles the **shallow** (1-hop) supersession query
  the pruner needs well. It will NOT match Neo4j for **deep multi-hop** traversals
  (e.g. long supersession chains, transitive `REFERENCED_IN` graphs). If a future
  feature needs deep traversal at scale, that is the trigger to revisit Neo4j (the
  interface makes it a drop-in). Recorded so the choice is re-evaluated on evidence,
  not forgotten.
- **Security posture** matches Tier-2: the new tables are RLS-enabled (deny-by-default;
  service-role bypasses), and `find_superseded` is `SECURITY INVOKER` with `EXECUTE`
  revoked from `anon`/`authenticated`. See PB-31 for the standing RLS-policy follow-up.
- The live **TS-client** round-trip remains gated on `SUPABASE_SERVICE_KEY` in `.env`
  (the MCP proves the SQL; the supabase-js path is exercised by `verify-tier2` when
  the key is present), consistent with ADR-0012.

## Alternatives Considered

- **Wait for Neo4j + Pinecone accounts** — rejected (for now): blocks the ADR-0011
  fix + the v0.5.x ship gate indefinitely on an external input, when a capable store
  is already available. The interface keeps this option open for later.
- **Skip Tier-3 / keep stubs** — rejected: the supersession fix and `/understand-codebase`
  both require a graph; stubs block both.
- **A separate embedded graph DB (e.g. a local store)** — rejected: violates "no
  SQLite" + adds an operational surface; Supabase is already the persistence plane.
- **Model the graph as JSONB on an existing table** — rejected: loses FK integrity +
  the indexable edge queries; explicit entity/edge tables are the honest schema.
