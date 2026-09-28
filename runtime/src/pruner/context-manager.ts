/**
 * Shadow Context Manager (Phase 2/3 integration) — composes the three verified
 * pieces into the unit the proxy will eventually call: the bi-encoder (text →
 * L2-normalized embedding), Tier-1 hot memory (rolling window of turns +
 * embeddings), and the KadaneDial pruner (relevance + temporal-decay selection).
 *
 *   ingest(turn)  → encode the turn once, store it (+ embedding) in Tier-1.
 *   select(query) → encode the query, prune Tier-1's window → the relevant turns.
 *
 * SHADOW-MODE: this is the integration seam, NOT wired into the proxy request
 * path. Per the constitution + ADR-0009, pruning does not alter requests until
 * the published Tier-A eval passes. The encoder is injected, so this composes +
 * is unit-tested end-to-end without the model (a test/injected encoder); the
 * real ONNX encoder drops in unchanged.
 */

import type { BiEncoder } from "./encoder";
import { prune, type HistoryEmbedding } from "./pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams, type PruneDecision } from "./kadanedial";
import { createHotMemory, type HotMemory, type HotTurn } from "../memory/hot/tier1";

/** A turn arriving at the manager (content is what gets embedded). */
export interface IncomingTurn {
  role: string;
  content: string;
  /** Unix ms timestamp. */
  timestampMs: number;
  /** Trusted caller-supplied project binding. */
  scopeId?: string;
  /** Trusted exchange provenance for later selected-turn decisions. */
  exchangeId?: string;
}

/** Per-call dial overrides (λ / g / θ); `nowSeconds` is supplied by select(). */
export type DialOverrides = Partial<Omit<KadaneDialParams, "nowSeconds">>;

export interface ContextManager {
  /** Encode a turn + add it (with its embedding) to Tier-1 hot memory. */
  ingest(turn: IncomingTurn): Promise<void>;
  /**
   * Select the relevant prior turns for a query (SHADOW — observation only).
   * @param query - the current query text.
   * @param nowMs - current time (ms) for temporal decay + window eviction.
   * @returns the pruning decision + the selected turns (in window order).
   */
  select(query: string, nowMs: number, queryScopeId?: string): Promise<{ decision: PruneDecision; selectedTurns: HotTurn[] }>;
  /** The underlying hot memory (for inspection / metrics). */
  hot: HotMemory;
}

export interface ContextManagerOptions {
  /** Injectable hot memory (default a fresh 2h window). */
  hot?: HotMemory;
  /** Dial overrides (λ / g / θ). Defaults to DEFAULT_KADANEDIAL. */
  dial?: DialOverrides;
  /**
   * OPT-IN (default off): SCALE-INVARIANT temporal decay (ADR-0015). When set, the
   * decay horizon is this FRACTION of the live window's OWN span (computed per
   * select()), instead of the fixed per-hour λ — so a turn from "the previous
   * session" decays the same whether the dialogue spans hours or weeks. Validated
   * on LoCoMo + LongMemEval (gold-evidence survival ~2% → ~93%; ADR-0015). Off ⇒
   * the documented per-hour λ (behaviour unchanged). SHADOW + Tier-A-gated before
   * it can become a default (constitution / ADR-0014); the judged ship-decision
   * run is the gate.
   */
  decayHorizonFraction?: number;
}

/**
 * Create a shadow context manager over an encoder.
 *
 * @param encoder - the bi-encoder (real ONNX or an injected/test encoder).
 * @param opts - hot memory + dial overrides.
 * @returns a {@link ContextManager}.
 */
export function createContextManager(encoder: BiEncoder, opts: ContextManagerOptions = {}): ContextManager {
  const hot = opts.hot ?? createHotMemory();
  const decayHorizonFraction = opts.decayHorizonFraction;
  const dial: Omit<KadaneDialParams, "nowSeconds"> = {
    lambda: opts.dial?.lambda ?? DEFAULT_KADANEDIAL.lambda,
    gainShift: opts.dial?.gainShift ?? DEFAULT_KADANEDIAL.gainShift,
    theta: opts.dial?.theta ?? DEFAULT_KADANEDIAL.theta,
    ...(opts.dial?.trimCarriedTurns !== undefined ? { trimCarriedTurns: opts.dial.trimCarriedTurns } : {}),
    ...(opts.dial?.decayHorizonSeconds !== undefined ? { decayHorizonSeconds: opts.dial.decayHorizonSeconds } : {}),
  };

  return {
    hot,
    async ingest(turn: IncomingTurn): Promise<void> {
      const [embedding] = await encoder.encode([turn.content]);
      hot.add({
        timestamp: turn.timestampMs,
        role: turn.role,
        content: turn.content,
        ...(embedding ? { embedding } : {}),
        ...(turn.scopeId ? { scopeId: turn.scopeId } : {}),
        ...(turn.exchangeId ? { exchangeId: turn.exchangeId } : {}),
      });
    },
    async select(query: string, nowMs: number, queryScopeId?: string): Promise<{ decision: PruneDecision; selectedTurns: HotTurn[] }> {
      const [queryVec] = await encoder.encode([query]);
      hot.sweep(nowMs); // evict against the SAME clock prune() decays with (no skew)
      const live = hot.recent();
      if (!queryVec || live.length === 0) {
        return { decision: prune(queryVec ?? new Float32Array(encoder.dimension), [], { ...dial, nowSeconds: nowMs / 1000 }, queryScopeId), selectedTurns: [] };
      }
      // Turns without an embedding (shouldn't happen post-ingest) are skipped.
      const indexed = live.map((t, i) => ({ t, i })).filter((x) => x.t.embedding);
      const history: HistoryEmbedding[] = indexed.map((x) => ({ embedding: x.t.embedding!, timestampSeconds: x.t.timestamp / 1000, ...(x.t.scopeId ? { scopeId: x.t.scopeId } : {}) }));
      // Scale-invariant decay (ADR-0015, default-off): horizon = fraction × the
      // window's own span (seconds). history is ascending by timestamp (Tier-1
      // keeps order), so span = last − first. ≥2 turns needed for a span.
      const params: KadaneDialParams = { ...dial, nowSeconds: nowMs / 1000 };
      const spanHistory = queryScopeId === undefined ? history : history.filter((turn) => turn.scopeId === queryScopeId);
      if (decayHorizonFraction !== undefined && spanHistory.length > 1) {
        const spanSeconds = spanHistory[spanHistory.length - 1]!.timestampSeconds - spanHistory[0]!.timestampSeconds;
        params.decayHorizonSeconds = Math.max(1, decayHorizonFraction * spanSeconds);
      }
      const decision = prune(queryVec, history, params, queryScopeId);
      const selectedTurns = decision.selectedIndices.map((di) => indexed[di]!.t);
      return { decision, selectedTurns };
    },
  };
}
