// Unit tests for understandEntity (/understand-codebase query core) — pure
// assembly over a fake KnowledgeGraph (+ optional fake VectorStore), no DB. The
// live entity_status SQL is verified via the Supabase MCP.

import { describe, test, expect } from "vitest";
import { understandEntity } from "../../src/memory/understand";
import type { KnowledgeGraph, EntityStatusEdge } from "../../src/memory/cold/graph";
import type { VectorStore, VectorMatch } from "../../src/memory/cold/vectors";

function graphWith(edges: EntityStatusEdge[]): KnowledgeGraph {
  return {
    async ensureEntity() {
      return "id";
    },
    async addEdge() {
      return "edge";
    },
    async findSuperseded() {
      return [];
    },
    async entityStatus() {
      return edges;
    },
  };
}

describe("understandEntity", () => {
  test("assembles supersededBy + supersedes from SUPERSEDES edges (both directions)", async () => {
    const graph = graphWith([
      { direction: "incoming", edgeType: "SUPERSEDES", otherName: "archiveUser" },
      { direction: "outgoing", edgeType: "SUPERSEDES", otherName: "getUser" },
    ]);
    const u = await understandEntity(graph, "o1", "fetchUser");
    expect(u.isSuperseded).toBe(true);
    expect(u.supersededBy).toEqual(["archiveUser"]); // a newer entity supersedes fetchUser
    expect(u.supersedes).toEqual(["getUser"]); // fetchUser supersedes an older one
    expect(u.related).toBeUndefined();
  });

  test("not superseded when there is no incoming SUPERSEDES", async () => {
    const graph = graphWith([{ direction: "outgoing", edgeType: "SUPERSEDES", otherName: "getUser" }]);
    const u = await understandEntity(graph, "o1", "fetchUser");
    expect(u.isSuperseded).toBe(false);
    expect(u.supersededBy).toEqual([]);
    expect(u.supersedes).toEqual(["getUser"]);
  });

  test("classifies deprecatedBy + referencedBy", async () => {
    const graph = graphWith([
      { direction: "outgoing", edgeType: "DEPRECATED_BY", otherName: "newApi" },
      { direction: "incoming", edgeType: "REFERENCED_IN", otherName: "billing.ts" },
    ]);
    const u = await understandEntity(graph, "o1", "oldApi");
    expect(u.deprecatedBy).toEqual(["newApi"]);
    expect(u.referencedBy).toEqual(["billing.ts"]);
  });

  test("empty status → all empty, not superseded", async () => {
    const u = await understandEntity(graphWith([]), "o1", "x");
    expect(u).toEqual({ name: "x", isSuperseded: false, supersededBy: [], supersedes: [], deprecatedBy: [], referencedBy: [] });
  });

  test("includes semantic neighbours when a vector store + query embedding are given", async () => {
    const matches: VectorMatch[] = [{ id: "v1", sourceType: "fact", sourceRef: "f1", similarity: 0.9 }];
    const vectors: VectorStore = {
      async upsert() {
        return 0;
      },
      async search() {
        return matches;
      },
    };
    const u = await understandEntity(graphWith([]), "o1", "x", { vectors, queryEmbedding: [0.1], relatedK: 3 });
    expect(u.related).toEqual(matches);
  });
});
