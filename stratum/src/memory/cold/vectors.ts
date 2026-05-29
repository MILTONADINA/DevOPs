/**
 * Tier-3 cold memory — vector store (Supabase pgvector implementation).
 *
 * Per ADR-0013, the blueprint's Pinecone role is served by pgvector on the live
 * Supabase project (migration 20260529130000), behind this {@link VectorStore}
 * SEAM so a future Pinecone adapter drops in unchanged.
 *
 * CONSTITUTION: the store holds ONLY embeddings + a pointer (source_type/
 * source_ref) to the typed row each was derived from — never plaintext content
 * ("Do not store raw unencrypted context in Supabase/Pinecone"). Recall resolves
 * content from the typed Tier-2 tables via source_ref.
 *
 * Embeddings are 384-d (all-MiniLM-L6-v2; {@link EMBEDDING_DIM}); a dim mismatch
 * fails loud rather than corrupting the index. Vectors are passed in pgvector's
 * text literal form (`[v1,v2,…]`), the form verified live via the Supabase MCP.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMBEDDING_DIM } from "../../pruner/encoder";

export type VectorSourceType = "fact" | "turn" | "entity";

/** A vector to store: the embedding + a pointer to its typed source (no content). */
export interface VectorRecord {
  orgId: string;
  sessionId?: string;
  sourceType: VectorSourceType;
  /** Pointer to the source row (e.g. a fact id) — NOT content. */
  sourceRef?: string;
  /** 384-d embedding (L2-normalized, from the encoder). */
  embedding: number[];
}

/** A similarity hit (newest of `match_count`, by cosine similarity). */
export interface VectorMatch {
  id: string;
  sourceType: string;
  sourceRef: string | null;
  /** Cosine similarity in [-1, 1] (1 = identical direction). */
  similarity: number;
}

export interface VectorStore {
  /**
   * Insert embedding records.
   * @param records - vectors + source pointers (no content).
   * @returns the number of rows written.
   * @throws {Error} on a dimension mismatch or a DB error.
   */
  upsert(records: VectorRecord[]): Promise<number>;
  /**
   * Cosine-similarity search within an org.
   * @param orgId - the owning organization.
   * @param queryEmbedding - the 384-d query vector.
   * @param k - max hits (default 10).
   * @returns matches, most-similar first.
   * @throws {Error} on a dimension mismatch or a DB error.
   */
  search(orgId: string, queryEmbedding: number[], k?: number): Promise<VectorMatch[]>;
}

/** pgvector text literal form: `[v1,v2,…]` (the form verified live via MCP). */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function assertDim(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`embedding dimension ${embedding.length} != expected ${EMBEDDING_DIM}`);
  }
}

/**
 * Create a Supabase/pgvector-backed vector store.
 *
 * @param client - a configured Supabase client (service-role key; bypasses RLS).
 * @returns a {@link VectorStore}.
 */
export function createVectorStore(client: SupabaseClient): VectorStore {
  return {
    async upsert(records: VectorRecord[]): Promise<number> {
      if (records.length === 0) return 0;
      const rows = records.map((r) => {
        assertDim(r.embedding);
        const row: Record<string, unknown> = {
          org_id: r.orgId,
          source_type: r.sourceType,
          embedding: toVectorLiteral(r.embedding),
        };
        if (r.sessionId !== undefined) row["session_id"] = r.sessionId;
        if (r.sourceRef !== undefined) row["source_ref"] = r.sourceRef;
        return row;
      });
      const { error } = await client.from("memory_vectors").insert(rows);
      if (error) throw new Error(`vector upsert failed: ${error.message}`);
      return rows.length;
    },

    async search(orgId: string, queryEmbedding: number[], k = 10): Promise<VectorMatch[]> {
      assertDim(queryEmbedding);
      const { data, error } = await client.rpc("match_memory_vectors", {
        query_embedding: toVectorLiteral(queryEmbedding),
        match_org: orgId,
        match_count: k,
      });
      if (error) throw new Error(`vector search failed: ${error.message}`);
      return ((data ?? []) as { id: string; source_type: string; source_ref: string | null; similarity: number }[]).map((r) => ({
        id: r.id,
        sourceType: r.source_type,
        sourceRef: r.source_ref,
        similarity: r.similarity,
      }));
    },
  };
}
