// Supplemental tests for warm->cold promotion: trusted org/session/project-scope propagation (including an
// explicit null scope, which must NOT be dropped), the promoteFacts orchestrator's gating, empty new_name,
// fact text for the remaining fact types, and the dropped-embedding guard. Synthetic data only.

import { describe, test, expect, vi } from "vitest";
import { factToGraphOps, factToText, promoteFacts, promoteFactsToGraph, promoteFactsToVectors } from "../../src/memory/promote";
import type { KnowledgeGraph } from "../../src/memory/cold/graph";
import type { VectorStore, VectorRecord } from "../../src/memory/cold/vectors";
import type { BiEncoder } from "../../src/pruner/encoder";
import type { AnyFact } from "../../src/types/facts";

const base = { id: "f1", created_at: "2026-05-29T00:00:00Z", session_id: "s1", confidence: 0.9, is_verified: false, is_suppressed: false } as const;
const fc = (over: Record<string, unknown> = {}): AnyFact => ({ ...base, fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed", ...over }) as AnyFact;

function spyGraph() {
  let n = 0;
  const ensureEntity = vi.fn(async () => `e${++n}`);
  const addEdge = vi.fn(async () => "edge");
  return { graph: { ensureEntity, addEdge } as unknown as KnowledgeGraph, ensureEntity, addEdge };
}
function spyVectors() {
  const upsert = vi.fn(async (r: VectorRecord[]) => r.length);
  return { vectors: { upsert } as unknown as VectorStore, upsert };
}
const encoderOf = (rows: (Float32Array | undefined)[]): BiEncoder => ({ encode: vi.fn(async () => rows) }) as unknown as BiEncoder;

describe("factToGraphOps edge cases", () => {
  test("an empty-string new_name is treated as absent (no phantom entity, no self-referential edge)", () => {
    expect(factToGraphOps(fc({ new_name: "" }))).toEqual({ entities: [{ kind: "Function", name: "getUser" }], edges: [] });
  });

  test.each([
    ["VariableChange", { fact_type: "VariableChange", var_name: "X", old_value: "1", new_value: "2" }],
    ["OperationalReference", { fact_type: "OperationalReference", subject: "runbook", reference: "docs/run.md" }],
  ])("%s yields no graph ops", (_n, over) => {
    expect(factToGraphOps({ ...base, ...over } as unknown as AnyFact)).toEqual({ entities: [], edges: [] });
  });
});

describe("promoteFactsToGraph context propagation", () => {
  test("org, session and project scope reach both ensureEntity and addEdge, and the edge points new -> old by id", async () => {
    const { graph, ensureEntity, addEdge } = spyGraph();
    const res = await promoteFactsToGraph(graph, [fc()], { orgId: "org1", sessionId: "s9", projectScope: "orion" });
    expect(res).toEqual({ entities: 2, edges: 1 });
    expect(ensureEntity.mock.calls.map((c) => c[0])).toEqual([
      { orgId: "org1", kind: "Function", name: "getUser", sessionId: "s9", projectScope: "orion" },
      { orgId: "org1", kind: "Function", name: "fetchUser", sessionId: "s9", projectScope: "orion" },
    ]);
    // e1 = getUser (old), e2 = fetchUser (new): the new entity supersedes the old one.
    expect(addEdge).toHaveBeenCalledWith({ orgId: "org1", fromEntity: "e2", toEntity: "e1", edgeType: "SUPERSEDES", sessionId: "s9", projectScope: "orion" });
  });

  test("an explicit null project scope (unbound session) is passed through, not dropped", async () => {
    const { graph, ensureEntity, addEdge } = spyGraph();
    await promoteFactsToGraph(graph, [fc()], { orgId: "org1", projectScope: null });
    expect(ensureEntity.mock.calls[0]![0]).toHaveProperty("projectScope", null);
    expect(addEdge.mock.calls[0]![0]).toHaveProperty("projectScope", null);
  });

  test("an omitted scope and session are omitted from the calls entirely", async () => {
    const { graph, ensureEntity, addEdge } = spyGraph();
    await promoteFactsToGraph(graph, [fc()], { orgId: "org1" });
    expect(Object.keys(ensureEntity.mock.calls[0]![0]).sort()).toEqual(["kind", "name", "orgId"]);
    expect(Object.keys(addEdge.mock.calls[0]![0]).sort()).toEqual(["edgeType", "fromEntity", "orgId", "toEntity"]);
  });

  test("entity ids are resolved per fact: identical names in two facts never reuse the first fact's ids", async () => {
    const { graph, addEdge } = spyGraph();
    await promoteFactsToGraph(graph, [fc({ id: "a" }), fc({ id: "b" })], { orgId: "org1" });
    expect(addEdge.mock.calls.map((c) => [c[0].fromEntity, c[0].toEntity])).toEqual([["e2", "e1"], ["e4", "e3"]]);
  });

  test("no facts, and facts with no graph ops, write nothing", async () => {
    const { graph, ensureEntity, addEdge } = spyGraph();
    expect(await promoteFactsToGraph(graph, [], { orgId: "o" })).toEqual({ entities: 0, edges: 0 });
    expect(await promoteFactsToGraph(graph, [{ ...base, fact_type: "Todo", description: "d", status: "open" } as AnyFact], { orgId: "o" })).toEqual({ entities: 0, edges: 0 });
    expect(ensureEntity).not.toHaveBeenCalled();
    expect(addEdge).not.toHaveBeenCalled();
  });

  test("a failing graph write rejects instead of reporting partial success", async () => {
    const { graph, ensureEntity } = spyGraph();
    ensureEntity.mockRejectedValueOnce(new Error("graph down"));
    await expect(promoteFactsToGraph(graph, [fc()], { orgId: "o" })).rejects.toThrow("graph down");
  });
});

describe("factToText", () => {
  test("renders each remaining fact type and the optional new_name arrow", () => {
    expect(factToText(fc({ new_name: undefined }))).toBe("function getUser (renamed)");
    expect(factToText(fc())).toBe("function getUser → fetchUser (renamed)");
    expect(factToText({ ...base, fact_type: "VariableChange", var_name: "LIMIT", old_value: "1", new_value: "5" } as unknown as AnyFact)).toBe("variable LIMIT = 5");
    expect(factToText({ ...base, fact_type: "OperationalReference", subject: "runbook", reference: "docs/run.md" } as unknown as AnyFact)).toBe("reference runbook: docs/run.md");
    expect(factToText({ ...base, fact_type: "Todo", description: "ship", status: "open" } as AnyFact)).toBe("todo: ship");
    expect(factToText({ ...base, fact_type: "PolicyUpdate", policy_name: "retention", new_value: "30d", policy_type: "data" } as AnyFact)).toBe("policy retention: 30d");
  });
});

describe("promoteFactsToVectors", () => {
  test("no facts: the encoder is never called and nothing is upserted", async () => {
    const { vectors, upsert } = spyVectors();
    const enc = encoderOf([]);
    expect(await promoteFactsToVectors(enc, vectors, [], { orgId: "o" })).toBe(0);
    expect(enc.encode).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  test("a missing or empty embedding drops only that fact, keeping the others aligned to their own ids", async () => {
    const { vectors, upsert } = spyVectors();
    const enc = encoderOf([new Float32Array([1, 2]), undefined, new Float32Array([]), new Float32Array([3])]);
    const facts = ["a", "b", "c", "d"].map((id) => fc({ id }));
    const n = await promoteFactsToVectors(enc, vectors, facts, { orgId: "org1", sessionId: "s9" });
    expect(n).toBe(2);
    expect(upsert.mock.calls[0]![0]).toEqual([
      { orgId: "org1", sourceType: "fact", sourceRef: "a", embedding: [1, 2], sessionId: "s9" },
      { orgId: "org1", sourceType: "fact", sourceRef: "d", embedding: [3], sessionId: "s9" },
    ]);
  });

  test("records are content-free: only the pointer and embedding are stored, never the fact text", async () => {
    const { vectors, upsert } = spyVectors();
    await promoteFactsToVectors(encoderOf([new Float32Array([1])]), vectors, [fc()], { orgId: "o" });
    const rec = upsert.mock.calls[0]![0][0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(rec)).not.toContain("getUser");
    expect(Object.keys(rec).sort()).toEqual(["embedding", "orgId", "sourceRef", "sourceType"]);
  });

  test("the encoder receives one text per fact, in order", async () => {
    const { vectors } = spyVectors();
    const enc = encoderOf([new Float32Array([1]), new Float32Array([1])]);
    await promoteFactsToVectors(enc, vectors, [fc(), { ...base, id: "t", fact_type: "Todo", description: "ship", status: "open" } as AnyFact], { orgId: "o" });
    expect(enc.encode).toHaveBeenCalledWith(["function getUser → fetchUser (renamed)", "todo: ship"]);
  });
});

describe("promoteFacts orchestrator", () => {
  const facts = [fc()];

  test("with no promoters nothing runs and all counts are zero", async () => {
    expect(await promoteFacts({}, facts, { orgId: "o" })).toEqual({ entities: 0, edges: 0, vectors: 0 });
  });

  test("a vector store without an encoder (or the reverse) is skipped, not half-run", async () => {
    const { vectors, upsert } = spyVectors();
    const enc = encoderOf([new Float32Array([1])]);
    expect(await promoteFacts({ vectors }, facts, { orgId: "o" })).toMatchObject({ vectors: 0 });
    expect(await promoteFacts({ encoder: enc }, facts, { orgId: "o" })).toMatchObject({ vectors: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(enc.encode).not.toHaveBeenCalled();
  });

  test("graph and vector promoters combine their counts", async () => {
    const { graph } = spyGraph();
    const { vectors } = spyVectors();
    const res = await promoteFacts({ graph, vectors, encoder: encoderOf([new Float32Array([1])]) }, facts, { orgId: "o" });
    expect(res).toEqual({ entities: 2, edges: 1, vectors: 1 });
  });

  test("a graph failure prevents any vector write", async () => {
    const { graph, ensureEntity } = spyGraph();
    ensureEntity.mockRejectedValueOnce(new Error("graph down"));
    const { vectors, upsert } = spyVectors();
    await expect(promoteFacts({ graph, vectors, encoder: encoderOf([new Float32Array([1])]) }, facts, { orgId: "o" })).rejects.toThrow("graph down");
    expect(upsert).not.toHaveBeenCalled();
  });
});
