// Unit tests for the Tier-3 vector store (Supabase/pgvector) against the fake
// client. The live similarity ordering (HNSW + cosine + match_memory_vectors) is
// verified via the Supabase MCP; this covers the adapter's literal formatting,
// dimension guard, and rpc mapping with no credentials.

import { describe, test, expect } from "vitest";
import { toVectorLiteral, createVectorStore } from "../../src/memory/cold/vectors";
import { EMBEDDING_DIM } from "../../src/pruner/encoder";
import { makeFakeSupabase } from "./fake-supabase";

/** A 384-d unit vector with a single 1 at `at`. */
const vec = (at = 0): number[] => {
  const a = new Array(EMBEDDING_DIM).fill(0) as number[];
  a[at] = 1;
  return a;
};

describe("toVectorLiteral", () => {
  test("formats a pgvector text literal", () => {
    expect(toVectorLiteral([1, 0, 0.5])).toBe("[1,0,0.5]");
  });
});

describe("VectorStore.upsert (fake client)", () => {
  test("formats embeddings as pgvector literals and inserts; omits absent session", async () => {
    const { client, store } = makeFakeSupabase();
    const vs = createVectorStore(client);
    const n = await vs.upsert([{ orgId: "o1", sourceType: "fact", sourceRef: "f1", embedding: vec(0) }]);
    expect(n).toBe(1);
    const row = store["memory_vectors"]![0]!;
    expect(row["org_id"]).toBe("o1");
    expect(row["source_type"]).toBe("fact");
    expect(row["source_ref"]).toBe("f1");
    expect(typeof row["embedding"]).toBe("string");
    expect((row["embedding"] as string).startsWith("[1,0,")).toBe(true);
    expect("session_id" in row).toBe(false);
  });

  test("throws on a dimension mismatch (fail-loud, never corrupt the index)", async () => {
    const { client } = makeFakeSupabase();
    const vs = createVectorStore(client);
    await expect(vs.upsert([{ orgId: "o1", sourceType: "fact", embedding: [1, 0, 0] }])).rejects.toThrow(/dimension 3 != expected 384/);
  });

  test("empty input → 0, nothing written", async () => {
    const { client, store } = makeFakeSupabase();
    const vs = createVectorStore(client);
    expect(await vs.upsert([])).toBe(0);
    expect(store["memory_vectors"]).toBeUndefined();
  });

  test("throws when the insert errors", async () => {
    const { client } = makeFakeSupabase({}, { insertError: new Set(["memory_vectors"]) });
    const vs = createVectorStore(client);
    await expect(vs.upsert([{ orgId: "o1", sourceType: "fact", embedding: vec(0) }])).rejects.toThrow(/vector upsert failed/);
  });
});

describe("VectorStore.search (fake client)", () => {
  test("maps the rpc result (source_ref/similarity) and formats the query vector", async () => {
    let seenArgs: Record<string, unknown> = {};
    const { client } = makeFakeSupabase({}, {}, {
      match_memory_vectors: (args) => {
        seenArgs = args;
        return [{ id: "v1", source_type: "fact", source_ref: "f1", similarity: 1 }];
      },
    });
    const vs = createVectorStore(client);
    const hits = await vs.search("o1", vec(0), 5);
    expect(hits).toEqual([{ id: "v1", sourceType: "fact", sourceRef: "f1", similarity: 1 }]);
    expect(typeof seenArgs["query_embedding"]).toBe("string"); // pgvector literal
    expect(seenArgs["match_org"]).toBe("o1");
    expect(seenArgs["match_count"]).toBe(5);
  });

  test("throws on a dimension mismatch", async () => {
    const { client } = makeFakeSupabase();
    const vs = createVectorStore(client);
    await expect(vs.search("o1", [1, 2, 3])).rejects.toThrow(/dimension 3 != expected 384/);
  });

  test("throws when the rpc errors", async () => {
    const { client } = makeFakeSupabase(); // no handler → rpc returns an error
    const vs = createVectorStore(client);
    await expect(vs.search("o1", vec(0))).rejects.toThrow(/vector search failed/);
  });
});
