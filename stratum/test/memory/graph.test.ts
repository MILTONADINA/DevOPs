// Unit tests for the Tier-3 knowledge-graph adapter (Supabase) against the fake
// client. The live SQL (schema + find_superseded supersession query) is verified
// via the Supabase MCP; this covers the adapter's create-or-get + rpc mapping
// logic with no credentials.

import { describe, test, expect } from "vitest";
import { createKnowledgeGraph } from "../../src/memory/cold/graph";
import { makeFakeSupabase } from "./fake-supabase";

describe("Tier-3 knowledge graph (Supabase adapter)", () => {
  test("ensureEntity creates a node when absent and returns its id", async () => {
    const { client, store } = makeFakeSupabase();
    const g = createKnowledgeGraph(client);
    const id = await g.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256" });
    expect(id).toBeTruthy();
    expect(store["knowledge_entities"]).toHaveLength(1);
    expect(store["knowledge_entities"]![0]!["name"]).toBe("use RS256");
    expect(store["knowledge_entities"]![0]!["kind"]).toBe("Decision");
  });

  test("ensureEntity returns the EXISTING node id on (org,kind,name) match (no duplicate)", async () => {
    const { client, store } = makeFakeSupabase({ knowledge_entities: [{ id: "ke1", org_id: "o1", kind: "Decision", name: "use RS256" }] });
    const g = createKnowledgeGraph(client);
    const id = await g.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256" });
    expect(id).toBe("ke1");
    expect(store["knowledge_entities"]).toHaveLength(1);
  });

  test("addEdge creates a typed edge and returns its id", async () => {
    const { client, store } = makeFakeSupabase();
    const g = createKnowledgeGraph(client);
    const id = await g.addEdge({ orgId: "o1", fromEntity: "a", toEntity: "b", edgeType: "SUPERSEDES" });
    expect(id).toBeTruthy();
    expect(store["knowledge_edges"]).toHaveLength(1);
    expect(store["knowledge_edges"]![0]!["edge_type"]).toBe("SUPERSEDES");
  });

  test("addEdge returns the EXISTING edge id on (from,to,type) match", async () => {
    const { client, store } = makeFakeSupabase({ knowledge_edges: [{ id: "edge1", from_entity: "a", to_entity: "b", edge_type: "SUPERSEDES", org_id: "o1" }] });
    const g = createKnowledgeGraph(client);
    const id = await g.addEdge({ orgId: "o1", fromEntity: "a", toEntity: "b", edgeType: "SUPERSEDES" });
    expect(id).toBe("edge1");
    expect(store["knowledge_edges"]).toHaveLength(1);
  });

  test("findSuperseded maps the rpc result (superseded_by → supersededBy) — the ADR-0011 query", async () => {
    const { client } = makeFakeSupabase({}, {}, {
      find_superseded: (args) => {
        const names = (args["names"] as string[]) ?? [];
        return names.includes("AWS Lambda") ? [{ superseded: "AWS Lambda", superseded_by: "Cloudflare Workers" }] : [];
      },
    });
    const g = createKnowledgeGraph(client);
    const res = await g.findSuperseded("o1", ["AWS Lambda", "Cloudflare Workers"]);
    expect(res).toEqual([{ superseded: "AWS Lambda", supersededBy: "Cloudflare Workers" }]);
  });

  test("findSuperseded short-circuits on empty names (no rpc call)", async () => {
    const { client } = makeFakeSupabase(); // no rpc handler registered → would error if called
    const g = createKnowledgeGraph(client);
    expect(await g.findSuperseded("o1", [])).toEqual([]);
  });

  test("ensureEntity throws (FAIL-LOUD) when the select errors", async () => {
    const { client } = makeFakeSupabase({}, { selectError: new Set(["knowledge_entities"]) });
    const g = createKnowledgeGraph(client);
    await expect(g.ensureEntity({ orgId: "o1", kind: "Decision", name: "x" })).rejects.toThrow(/ensureEntity select failed/);
  });
});
