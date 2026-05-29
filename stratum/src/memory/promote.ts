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
