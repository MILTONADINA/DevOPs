// Unit tests for the Tier-3 knowledge-graph adapter (Supabase) against the fake
// client. The live SQL (schema + find_superseded supersession query) is verified
// via the Supabase MCP; this covers the adapter's create-or-get + rpc mapping
// logic with no credentials.

import { describe, test, expect } from "vitest";
import { createKnowledgeGraph } from "../../src/memory/cold/graph";
import { makeFakeSupabase } from "./fake-supabase";

describe("Tier-3 knowledge graph (Supabase adapter)", () => {
  test("keeps same-name graph rows and metadata separate by project, excluding uncertain history", async () => {
    const { client, store } = makeFakeSupabase({
      knowledge_entities: [{ id: "old", org_id: "o1", kind: "File", name: "src/auth.ts", summary: "uncertain historical summary", project_scope: null, scope_verified: false }],
    });
    const graph = createKnowledgeGraph(client);
    const orion = await graph.ensureEntity({ orgId: "o1", projectScope: "orion", kind: "File", name: "src/auth.ts", summary: "Orion auth" });
    const vega = await graph.ensureEntity({ orgId: "o1", projectScope: "vega", kind: "File", name: "src/auth.ts", summary: "Vega auth" });
    const unbound = await graph.ensureEntity({ orgId: "o1", projectScope: null, kind: "File", name: "src/auth.ts", summary: "Unbound auth" });
    expect(new Set([orion, vega, unbound, "old"]).size).toBe(4);
    expect(await graph.ensureEntity({ orgId: "o1", projectScope: "orion", kind: "File", name: "src/auth.ts" })).toBe(orion);
    expect(store["knowledge_entities"]).toMatchObject([
      { id: "old", scope_verified: false },
      { id: orion, project_scope: "orion", scope_verified: true, summary: "Orion auth" },
      { id: vega, project_scope: "vega", scope_verified: true, summary: "Vega auth" },
      { id: unbound, project_scope: null, scope_verified: true, summary: "Unbound auth" },
    ]);
  });

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

  test("reused entity records both trusted sessions without upgrading legacy provenance", async () => {
    const { client, store } = makeFakeSupabase({
      knowledge_entities: [{ id: "ke1", org_id: "o1", kind: "Decision", name: "use RS256", provenance_complete: false }],
    });
    const g = createKnowledgeGraph(client);
    expect(await g.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256", sessionId: "s1" })).toBe("ke1");
    expect(await g.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256", sessionId: "s2" })).toBe("ke1");
    expect(store["knowledge_entity_sessions"]).toMatchObject([
      { org_id: "o1", entity_id: "ke1", session_id: "s1" },
      { org_id: "o1", entity_id: "ke1", session_id: "s2" },
    ]);
    expect(store["knowledge_entities"]![0]!["provenance_complete"]).toBe(false);
  });

  test("unscoped graph reuse downgrades a tracked row to uncertain", async () => {
    const { client, store } = makeFakeSupabase({
      knowledge_entities: [{ id: "ke1", org_id: "o1", kind: "Decision", name: "use RS256", provenance_complete: true }],
      knowledge_edges: [{ id: "edge1", org_id: "o1", from_entity: "ke1", to_entity: "other", edge_type: "SUPERSEDES", provenance_complete: true }],
    });
    const graph = createKnowledgeGraph(client);
    await graph.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256" });
    await graph.addEdge({ orgId: "o1", fromEntity: "ke1", toEntity: "other", edgeType: "SUPERSEDES" });
    expect(store["knowledge_entities"]![0]!["provenance_complete"]).toBe(false);
    expect(store["knowledge_edges"]![0]!["provenance_complete"]).toBe(false);
  });

  test("new session graph rows are tagged complete and link writes fail loud", async () => {
    const { client, store } = makeFakeSupabase();
    const g = createKnowledgeGraph(client);
    const entity = await g.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256", sessionId: "s1" });
    const edge = await g.addEdge({ orgId: "o1", fromEntity: entity, toEntity: "other", edgeType: "SUPERSEDES", sessionId: "s1" });
    expect(store["knowledge_entities"]![0]!["provenance_complete"]).toBe(true);
    expect(store["knowledge_edges"]![0]!["provenance_complete"]).toBe(true);
    expect(store["knowledge_entity_sessions"]![0]).toMatchObject({ entity_id: entity, session_id: "s1" });
    expect(store["knowledge_edge_sessions"]![0]).toMatchObject({ edge_id: edge, session_id: "s1" });

    const failing = createKnowledgeGraph(
      makeFakeSupabase({ knowledge_entities: [{ id: "ke1", org_id: "o1", kind: "Decision", name: "use RS256" }] }, { insertError: new Set(["knowledge_entity_sessions"]) }).client,
    );
    await expect(failing.ensureEntity({ orgId: "o1", kind: "Decision", name: "use RS256", sessionId: "s1" })).rejects.toThrow(/provenance/i);
  });

  test("source file metadata is stored and refreshed without a duplicate node", async () => {
    const { client, store } = makeFakeSupabase();
    const g = createKnowledgeGraph(client);
    const input = { orgId: "o1", kind: "File" as const, name: "src/auth.ts", filePath: "src/auth.ts", summary: "Auth source" };
    const first = await g.ensureEntity(input);
    const second = await g.ensureEntity({ ...input, summary: "Updated auth source" });
    expect(first).toBe(second);
    expect(store["knowledge_entities"]).toHaveLength(1);
    expect(store["knowledge_entities"]![0]).toMatchObject({ file_path: "src/auth.ts", summary: "Updated auth source" });
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

  test("reused edge records each trusted session", async () => {
    const { client, store } = makeFakeSupabase({ knowledge_edges: [{ id: "edge1", from_entity: "a", to_entity: "b", edge_type: "SUPERSEDES", org_id: "o1" }] });
    const g = createKnowledgeGraph(client);
    expect(await g.addEdge({ orgId: "o1", fromEntity: "a", toEntity: "b", edgeType: "SUPERSEDES", sessionId: "s1" })).toBe("edge1");
    expect(await g.addEdge({ orgId: "o1", fromEntity: "a", toEntity: "b", edgeType: "SUPERSEDES", sessionId: "s2" })).toBe("edge1");
    expect(store["knowledge_edge_sessions"]).toMatchObject([
      { org_id: "o1", edge_id: "edge1", session_id: "s1" },
      { org_id: "o1", edge_id: "edge1", session_id: "s2" },
    ]);
  });

  test("findSuperseded maps the rpc result (superseded_by → supersededBy) — the ADR-0011 query", async () => {
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        find_superseded: (args) => {
          const names = (args["names"] as string[]) ?? [];
          return names.includes("AWS Lambda") ? [{ superseded: "AWS Lambda", superseded_by: "Cloudflare Workers" }] : [];
        },
      },
    );
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

  test("entityStatus maps the rpc result (other_name → otherName; direction/edgeType)", async () => {
    const { client } = makeFakeSupabase(
      {},
      {},
      {
        entity_status: (args) =>
          args["entity_name"] === "fetchUser"
            ? [
                { direction: "incoming", edge_type: "SUPERSEDES", other_name: "archiveUser" },
                { direction: "outgoing", edge_type: "SUPERSEDES", other_name: "getUser" },
              ]
            : [],
      },
    );
    const g = createKnowledgeGraph(client);
    expect(await g.entityStatus("o1", "fetchUser")).toEqual([
      { direction: "incoming", edgeType: "SUPERSEDES", otherName: "archiveUser" },
      { direction: "outgoing", edgeType: "SUPERSEDES", otherName: "getUser" },
    ]);
  });
});
