/**
 * /understand-codebase — entity status query (Phase 3 / v0.5.x).
 *
 * Answers "what is the current status of X?" from the Tier-3 knowledge graph (+
 * optional semantic neighbours from the vector store) at ~tens of tokens instead of
 * re-reading thousands of turns. This is the QUERY core of the `/understand-codebase`
 * command: it assembles an entity's graph edges into a structured status. (Populating
 * the graph from a real codebase — the ingestion half — flows through the extractor →
 * promote pipeline and is gated on the real extractor model / a live corpus.)
 *
 * Pure assembly over the injected {@link KnowledgeGraph} (+ optional {@link VectorStore});
 * unit-tested with fakes, no DB.
 */

import type { KnowledgeGraph } from "./cold/graph";
import type { VectorStore, VectorMatch } from "./cold/vectors";

export interface EntityUnderstanding {
  name: string;
  /** True when some entity supersedes this one (an incoming SUPERSEDES edge). */
  isSuperseded: boolean;
  /** Newer entities that supersede this one. */
  supersededBy: string[];
  /** Older entities this one supersedes. */
  supersedes: string[];
  /** Entities that deprecate this one (outgoing DEPRECATED_BY). */
  deprecatedBy: string[];
  /** Entities that reference this one (incoming REFERENCED_IN). */
  referencedBy: string[];
  /** Semantic neighbours — present only when a vector store + query embedding are given. */
  related?: VectorMatch[];
}

export interface UnderstandOptions {
  /** Optional vector store for semantic neighbours. */
  vectors?: VectorStore;
  /** Query embedding (384-d) for the semantic-neighbour search. */
  queryEmbedding?: number[];
  /** Max semantic neighbours (default 5). */
  relatedK?: number;
}

/**
 * Assemble an entity's current status from the knowledge graph.
 *
 * @param graph - the knowledge graph.
 * @param orgId - the owning organization.
 * @param name - the entity to describe.
 * @param opts - optional vector store + query embedding for semantic neighbours.
 * @returns the structured {@link EntityUnderstanding}.
 * @throws {Error} if a graph/vector query fails.
 */
export async function understandEntity(
  graph: KnowledgeGraph,
  orgId: string,
  name: string,
  opts: UnderstandOptions = {},
): Promise<EntityUnderstanding> {
  const edges = await graph.entityStatus(orgId, name);
  const pick = (edgeType: string, direction: "incoming" | "outgoing"): string[] =>
    edges.filter((e) => e.edgeType === edgeType && e.direction === direction).map((e) => e.otherName);

  const supersededBy = pick("SUPERSEDES", "incoming");
  const result: EntityUnderstanding = {
    name,
    isSuperseded: supersededBy.length > 0,
    supersededBy,
    supersedes: pick("SUPERSEDES", "outgoing"),
    deprecatedBy: pick("DEPRECATED_BY", "outgoing"),
    referencedBy: pick("REFERENCED_IN", "incoming"),
  };

  if (opts.vectors && opts.queryEmbedding) {
    result.related = await opts.vectors.search(orgId, opts.queryEmbedding, opts.relatedK ?? 5);
  }
  return result;
}
