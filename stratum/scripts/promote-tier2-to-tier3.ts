/**
 * Nightly Promotion Job — Tier 2 → Tier 3
 *
 * Runs every night at 02:00 UTC.
 * Moves structured facts older than 30 days from Supabase
 * to Pinecone (vector) + Neo4j (graph).
 *
 * Steps:
 *   1. Query Supabase for facts older than 30 days
 *   2. Encode fact text to embedding (ada-002 equivalent)
 *   3. Upsert into Pinecone with metadata
 *   4. Upsert into Neo4j as typed nodes and edges
 *   5. Mark Supabase record as promoted (do not delete)
 *   6. Log promotion run results
 *
 * Usage: npm run promote
 */

// TODO: Implement promotion job (Phase 3)
