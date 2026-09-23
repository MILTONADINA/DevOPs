/**
 * Warm → Cold promotion (Tier-2 facts → Tier-3 knowledge graph) — Phase 3 / v0.5.x.
 *
 * The missing link between the tiers: typed Tier-2 facts are projected into Tier-3
 * graph entities + edges, so the graph (and `find_superseded`, and the ADR-0011
 * pruner suppression) actually fire on real memory rather than only hand-seeded data.
 * This closes the loop: hot → (evict) → extract → warm facts → PROMOTE → cold graph
 * → find_superseded → suppressSuperseded.
 *
 * The mapping is PURE (`factToGraphOps`) + unit-tested; `promoteFactsToGraph` applies
 * it over an injected {@link KnowledgeGraph} (Supabase today, Neo4j later). Only
 * relationships cleanly derivable from a SINGLE fact are emitted here — chiefly a
 * FunctionChange's "the new name supersedes the old" edge. Cross-fact / domain-level
 * supersession (e.g. a newer TechDecision in the same domain superseding the prior
 * one) needs server-side relationship resolution (the audit engine) and is NOT
 * guessed here; see ADR-0011.
 */

import type { AnyFact } from "../types/facts";
import type { KnowledgeGraph, EntityKind, EdgeType } from "./cold/graph";
import type { VectorStore, VectorSourceType } from "./cold/vectors";
import type { BiEncoder } from "../pruner/encoder";

/** Graph operations derived from a fact, expressed by entity NAME (resolved on apply). */
export interface GraphOps {
  entities: { kind: EntityKind; name: string }[];
  edges: { fromName: string; toName: string; edgeType: EdgeType }[];
}

/**
 * Project a single fact into graph operations (entities + edges), by name.
 *
 * - FunctionChange → a `Function` entity for `old_name`; if `new_name` is present,
 *   a `Function` entity for it + a `SUPERSEDES` edge (new_name supersedes old_name),
 *   for any change_type (deprecated / renamed / signature_changed all mean the new
 *   name replaces the old).
 * - TechDecision → a `Decision` entity (decision_text). No edge (decision-level
 *   supersession is server-resolved, not single-fact-derivable).
 * - PolicyUpdate → a `Policy` entity (policy_name).
 * - Todo / VariableChange → no graph node kind → no ops.
 *
 * @param fact - the validated fact.
 * @returns the graph operations (possibly empty).
 */
export function factToGraphOps(fact: AnyFact): GraphOps {
  switch (fact.fact_type) {
    case "FunctionChange": {
      const entities: GraphOps["entities"] = [{ kind: "Function", name: fact.old_name }];
      const edges: GraphOps["edges"] = [];
      if (fact.new_name !== undefined && fact.new_name.length > 0) {
        entities.push({ kind: "Function", name: fact.new_name });
        edges.push({ fromName: fact.new_name, toName: fact.old_name, edgeType: "SUPERSEDES" });
      }
      return { entities, edges };
    }
    case "TechDecision":
      return { entities: [{ kind: "Decision", name: fact.decision_text }], edges: [] };
    case "PolicyUpdate":
      return { entities: [{ kind: "Policy", name: fact.policy_name }], edges: [] };
    default:
      return { entities: [], edges: [] };
  }
}

export interface PromoteContext {
  orgId: string;
  sessionId?: string;
}

export interface PromoteResult {
  entities: number;
  edges: number;
}

/**
 * Promote facts into the knowledge graph: ensure each fact's entities, then add its
 * edges (resolving names → ids via the just-ensured entities).
 *
 * @param graph - the target {@link KnowledgeGraph}.
 * @param facts - the validated facts to promote.
 * @param ctx - trusted org/session FKs.
 * @returns counts of entities ensured + edges added.
 * @throws {Error} if an underlying graph write fails.
 */
export async function promoteFactsToGraph(graph: KnowledgeGraph, facts: AnyFact[], ctx: PromoteContext): Promise<PromoteResult> {
  let entities = 0;
  let edges = 0;
  for (const fact of facts) {
    const ops = factToGraphOps(fact);
    const idByName = new Map<string, string>();
    for (const e of ops.entities) {
      const id = await graph.ensureEntity({ orgId: ctx.orgId, kind: e.kind, name: e.name, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) });
      idByName.set(e.name, id);
      entities++;
    }
    for (const edge of ops.edges) {
      const fromId = idByName.get(edge.fromName);
      const toId = idByName.get(edge.toName);
      if (fromId === undefined || toId === undefined) continue; // unreachable: edge names are always ensured above
      await graph.addEdge({ orgId: ctx.orgId, fromEntity: fromId, toEntity: toId, edgeType: edge.edgeType, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) });
      edges++;
    }
  }
  return { entities, edges };
}

/**
 * The embeddable text for a fact — its semantic content, used to build the vector
 * recall index. This is the typed fact's own text (the same distilled form already
 * in Tier-2), NOT raw conversation; only its embedding + a pointer are stored.
 *
 * @param fact - the fact.
 * @returns a short text representation for encoding.
 */
export function factToText(fact: AnyFact): string {
  switch (fact.fact_type) {
    case "FunctionChange":
      return `function ${fact.old_name}${fact.new_name !== undefined ? ` → ${fact.new_name}` : ""} (${fact.change_type})`;
    case "TechDecision":
      return `decision: ${fact.decision_text} [${fact.domain}]`;
    case "PolicyUpdate":
      return `policy ${fact.policy_name}: ${fact.new_value}`;
    case "Todo":
      return `todo: ${fact.description}`;
    case "VariableChange":
      return `variable ${fact.var_name} = ${fact.new_value}`;
  }
}

/**
 * Promote facts into the vector store: encode each fact's text (OFFLINE ONNX
 * encoder — no API key) and upsert the embedding + a pointer (source_ref = fact id).
 * CONTENT-FREE per the constitution — only the embedding + pointer are stored, never
 * the text. This fills the semantic-recall index that /understand-codebase neighbours
 * and Tier-3 vector search read.
 *
 * @param encoder - the bi-encoder (real ONNX runs locally; tests inject a fake).
 * @param vectors - the target vector store.
 * @param facts - the validated facts to index.
 * @param ctx - trusted org/session FKs.
 * @returns the number of vectors upserted.
 * @throws {Error} if encoding or the upsert fails.
 */
export async function promoteFactsToVectors(encoder: BiEncoder, vectors: VectorStore, facts: AnyFact[], ctx: PromoteContext): Promise<number> {
  if (facts.length === 0) return 0;
  const embeddings = await encoder.encode(facts.map(factToText));
  const records = facts
    .map((fact, i) => {
      const emb = embeddings[i];
      return {
        orgId: ctx.orgId,
        sourceType: "fact" as VectorSourceType,
        sourceRef: fact.id,
        embedding: emb ? Array.from(emb) : [],
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      };
    })
    .filter((r) => r.embedding.length > 0);
  return vectors.upsert(records);
}

/** The promotion targets (any subset; vectors need an encoder too). */
export interface Promoters {
  graph?: KnowledgeGraph;
  vectors?: VectorStore;
  encoder?: BiEncoder;
}

/**
 * Promote facts to whichever Tier-3 stores are provided — the graph (entities/edges)
 * and/or the vector index. The orchestrator the nightly promote job calls.
 *
 * @param p - the available promoters (graph / vectors + encoder).
 * @param facts - the validated facts.
 * @param ctx - trusted org/session FKs.
 * @returns counts of entities, edges, and vectors written.
 * @throws {Error} if an underlying write fails.
 */
export async function promoteFacts(p: Promoters, facts: AnyFact[], ctx: PromoteContext): Promise<{ entities: number; edges: number; vectors: number }> {
  const graphResult = p.graph ? await promoteFactsToGraph(p.graph, facts, ctx) : { entities: 0, edges: 0 };
  const vectors = p.vectors && p.encoder ? await promoteFactsToVectors(p.encoder, p.vectors, facts, ctx) : 0;
  return { entities: graphResult.entities, edges: graphResult.edges, vectors };
}
