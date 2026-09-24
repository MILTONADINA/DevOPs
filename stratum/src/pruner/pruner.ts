/**
 * Pruner orchestrator (Phase 2 / v0.4.x).
 *
 * Wires the verified KadaneDial algorithm (kadanedial.ts) to stored turn
 * embeddings. Operates on EMBEDDINGS, not text: per docs/ALGORITHM.md, each
 * turn is encoded once at ingestion (incremental, O(1)/turn) and the embedding
 * is stored; pruning computes cosine similarities of the stored history
 * embeddings against the fresh query embedding, then runs KadaneDial.
 *
 * SHADOW-MODE / NOT WIRED: this is preparatory v0.4.x core. It is not invoked
 * from the proxy request path and pruning is enabled nowhere. The accuracy eval
 * (the project's definition of "correct") is deferred until the §2b corpus +
 * Tier-A datasets exist. `prune()` is pure/deterministic + unit-tested with
 * injected embeddings; its quality-preservation is unproven until the eval runs.
 */

import { cosineSimilarity } from "./encoder";
import { selectRelevantTurns, type KadaneDialParams, type PruneDecision, type HistoryTurn } from "./kadanedial";

/** A stored history-turn embedding + when the turn occurred. */
export interface HistoryEmbedding {
  /** L2-normalized turn embedding (computed + stored at ingestion). */
  embedding: Float32Array;
  /** Unix timestamp (seconds) when the turn was recorded. */
  timestampSeconds: number;
  /** Trusted caller-supplied project binding; never inferred from turn text. */
  scopeId?: string;
}

/**
 * Select the relevant history spans for the current query.
 *
 * @param queryEmbedding - the L2-normalized embedding of the current query.
 * @param history - stored history-turn embeddings (+ timestamps), in turn order.
 * @param params - KadaneDial params (λ / g / θ / now).
 * @returns the {@link PruneDecision} (selected + pruned indices + logged scores).
 */
export function prune(queryEmbedding: Float32Array, history: HistoryEmbedding[], params: KadaneDialParams, queryScopeId?: string): PruneDecision {
  if (queryScopeId !== undefined) {
    if (queryScopeId.trim() === "") throw new RangeError("query scope must be nonempty");
    const candidateIndices = history.flatMap((turn, index) => (turn.scopeId === queryScopeId ? [index] : []));
    const scoped = prune(
      queryEmbedding,
      candidateIndices.map((index) => history[index]!),
      params,
    );
    const selectedIndices = scoped.selectedIndices.map((index) => candidateIndices[index]!);
    const selected = new Set(selectedIndices);
    const spans: Array<[number, number]> = [];
    for (const index of selectedIndices) {
      const last = spans[spans.length - 1];
      if (last && last[1] === index - 1) last[1] = index;
      else spans.push([index, index]);
    }
    return {
      ...scoped,
      spans,
      selectedIndices,
      prunedIndices: history.map((_, index) => index).filter((index) => !selected.has(index)),
      candidateIndices,
    };
  }
  const turns: HistoryTurn[] = history.map((h) => ({
    similarity: cosineSimilarity(queryEmbedding, h.embedding),
    timestampSeconds: h.timestampSeconds,
  }));
  return selectRelevantTurns(turns, params);
}
