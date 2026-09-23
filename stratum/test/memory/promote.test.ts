// Unit tests for warm→cold promotion (facts → Tier-3 graph). The pure mapping
// (factToGraphOps) + promoteFactsToGraph over an in-memory KnowledgeGraph fake —
// no DB. Proves the loop closer: a FunctionChange yields the SUPERSEDES edge that
// find_superseded + the ADR-0011 suppression consume.

import { describe, test, expect } from "vitest";
import { factToGraphOps, promoteFactsToGraph, factToText, promoteFactsToVectors } from "../../src/memory/promote";
import type { KnowledgeGraph, EnsureEntityInput, AddEdgeInput, Supersession } from "../../src/memory/cold/graph";
import type { VectorStore, VectorRecord } from "../../src/memory/cold/vectors";
import type { BiEncoder } from "../../src/pruner/encoder";
import type { AnyFact, FunctionChangeFact, TechDecisionFact, PolicyUpdateFact, TodoFact } from "../../src/types/facts";

const base = { id: "f1", created_at: "2026-05-29T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: false, is_suppressed: false } as const;

describe("factToGraphOps", () => {
  test("FunctionChange with new_name → 2 Function entities + new SUPERSEDES old", () => {
    const fc: FunctionChangeFact = { ...base, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed" };
    expect(factToGraphOps(fc)).toEqual({
      entities: [
        { kind: "Function", name: "getUser" },
        { kind: "Function", name: "fetchUser" },
      ],
      edges: [{ fromName: "fetchUser", toName: "getUser", edgeType: "SUPERSEDES" }],
    });
  });

  test("FunctionChange without new_name → 1 entity, no edge", () => {
    const fc: FunctionChangeFact = { ...base, fact_type: "FunctionChange", old_name: "getUser", change_type: "deprecated" };
    expect(factToGraphOps(fc)).toEqual({ entities: [{ kind: "Function", name: "getUser" }], edges: [] });
  });

  test("TechDecision → a Decision entity", () => {
    const td: TechDecisionFact = { ...base, fact_type: "TechDecision", decision_text: "use Cloudflare Workers", domain: "deploy" };
    expect(factToGraphOps(td)).toEqual({ entities: [{ kind: "Decision", name: "use Cloudflare Workers" }], edges: [] });
  });

  test("PolicyUpdate → a Policy entity", () => {
    const pu: PolicyUpdateFact = { ...base, fact_type: "PolicyUpdate", policy_name: "pii-redaction", new_value: "fail-closed", policy_type: "security" };
    expect(factToGraphOps(pu)).toEqual({ entities: [{ kind: "Policy", name: "pii-redaction" }], edges: [] });
  });

  test("Todo → no graph ops (no matching node kind)", () => {
    const todo: TodoFact = { ...base, fact_type: "Todo", description: "ship it", status: "open" };
    expect(factToGraphOps(todo)).toEqual({ entities: [], edges: [] });
  });
});

// In-memory KnowledgeGraph fake (create-or-get by name).
function fakeGraph(): { graph: KnowledgeGraph; entities: { id: string; kind: string; name: string }[]; edges: { from: string; to: string; type: string }[] } {
  const entities: { id: string; kind: string; name: string }[] = [];
  const edges: { from: string; to: string; type: string }[] = [];
  const byName = new Map<string, string>();
  let seq = 0;
  const graph: KnowledgeGraph = {
    async ensureEntity(input: EnsureEntityInput): Promise<string> {
      const existing = byName.get(input.name);
      if (existing) return existing;
      const id = `e${++seq}`;
      byName.set(input.name, id);
      entities.push({ id, kind: input.kind, name: input.name });
      return id;
    },
    async addEdge(input: AddEdgeInput): Promise<string> {
      edges.push({ from: input.fromEntity, to: input.toEntity, type: input.edgeType });
      return `edge${++seq}`;
    },
    async findSuperseded(): Promise<Supersession[]> {
      return [];
    },
    async entityStatus(): Promise<[]> {
      return [];
    },
  };
  return { graph, entities, edges };
}

describe("promoteFactsToGraph", () => {
  test("promotes a FunctionChange: ensures both functions + the SUPERSEDES edge (new→old ids)", async () => {
    const { graph, entities, edges } = fakeGraph();
    const fc: FunctionChangeFact = { ...base, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed" };
    const result = await promoteFactsToGraph(graph, [fc], { orgId: "o1" });
    expect(result).toEqual({ entities: 2, edges: 1 });
    const getUser = entities.find((e) => e.name === "getUser")!;
    const fetchUser = entities.find((e) => e.name === "fetchUser")!;
    expect(edges).toEqual([{ from: fetchUser.id, to: getUser.id, type: "SUPERSEDES" }]); // new supersedes old
  });

  test("dedups entities across facts (create-or-get) and skips non-graph facts", async () => {
    const { graph, entities } = fakeGraph();
    const td1: TechDecisionFact = { ...base, fact_type: "TechDecision", decision_text: "use Postgres", domain: "db" };
    const td2: TechDecisionFact = { ...base, fact_type: "TechDecision", decision_text: "use Postgres", domain: "db" }; // same name
    const todo: TodoFact = { ...base, fact_type: "Todo", description: "x", status: "open" };
    const result = await promoteFactsToGraph(graph, [td1, td2, todo], { orgId: "o1" });
    expect(result.entities).toBe(2); // two ensure calls...
    expect(entities).toHaveLength(1); // ...but only one distinct entity persisted (create-or-get)
  });

  test("empty facts → zero ops", async () => {
    const { graph } = fakeGraph();
    expect(await promoteFactsToGraph(graph, [], { orgId: "o1" })).toEqual({ entities: 0, edges: 0 });
  });
});

// A fake 384-d encoder (no model load) + a recording vector store.
const DIM = 384;
function fakeEncoder(): BiEncoder {
  return {
    dimension: DIM,
    async encode(texts: string[]): Promise<Float32Array[]> {
      // distinct deterministic vectors per input (a 1 at a rolling slot)
      return texts.map((_t, i) => {
        const v = new Float32Array(DIM);
        v[i % DIM] = 1;
        return v;
      });
    },
  };
}
function recordingVectors(): { vectors: VectorStore; upserted: VectorRecord[] } {
  const upserted: VectorRecord[] = [];
  const vectors: VectorStore = {
    async upsert(records: VectorRecord[]): Promise<number> {
      upserted.push(...records);
      return records.length;
    },
    async search() {
      return [];
    },
  };
  return { vectors, upserted };
}

describe("factToText", () => {
  test("derives embeddable text per fact type", () => {
    expect(factToText({ ...base, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed" })).toBe("function getUser → fetchUser (renamed)");
    expect(factToText({ ...base, fact_type: "TechDecision", decision_text: "use CF Workers", domain: "deploy" })).toBe("decision: use CF Workers [deploy]");
    expect(factToText({ ...base, fact_type: "Todo", description: "ship it", status: "open" })).toBe("todo: ship it");
  });
});

describe("promoteFactsToVectors", () => {
  test("encodes fact text (offline) and upserts content-free records (embedding + source_ref)", async () => {
    const { vectors, upserted } = recordingVectors();
    const facts: AnyFact[] = [
      { ...base, id: "fa", fact_type: "TechDecision", decision_text: "use CF Workers", domain: "deploy" },
      { ...base, id: "fb", fact_type: "Todo", description: "ship it", status: "open" },
    ];
    const n = await promoteFactsToVectors(fakeEncoder(), vectors, facts, { orgId: "o1", sessionId: "s1" });
    expect(n).toBe(2);
    expect(upserted).toHaveLength(2);
    expect(upserted[0]!.sourceType).toBe("fact");
    expect(upserted[0]!.sourceRef).toBe("fa"); // pointer, not content
    expect(upserted[0]!.embedding).toHaveLength(DIM);
    expect(upserted[0]!.orgId).toBe("o1");
    expect((upserted[0] as { content?: unknown }).content).toBeUndefined(); // content-free
  });

  test("empty facts → 0 (no encode/upsert)", async () => {
    const { vectors, upserted } = recordingVectors();
    expect(await promoteFactsToVectors(fakeEncoder(), vectors, [], { orgId: "o1" })).toBe(0);
    expect(upserted).toHaveLength(0);
  });
});
