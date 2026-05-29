/**
 * Memory Manager — composes the three memory tiers into the unit the proxy's
 * eviction hook will call (Phase 3 / v0.5.x).
 *
 *   ingest(turn) → add to Tier-1 hot memory; any turn that ages out of the hot
 *                  window is DRAINED through the fact extractor → Tier-2 warm
 *                  persistence (the eviction → extract → persist pipeline).
 *   recall()     → the hot window + the durable facts read back from Tier-2.
 *
 * This is what makes a fact "survive" past the hot window: once a turn is evicted
 * it is distilled into typed facts (never a summary, per CLAUDE.md) and stored in
 * warm memory, so recall() still surfaces it long after it left RAM — the v0.5.x
 * "fact-survives-50-turn" acceptance criterion.
 *
 * Composes the verified pieces over injectable seams (Tier-1 hot, FactExtractor,
 * WarmMemory). No encoder is needed here — that is the pruner's (ContextManager's)
 * concern, not warm-fact recall. Tier-3 (Neo4j/Pinecone) semantic recall layers on
 * top later (gated on those accounts); this is the deterministic hot+warm path.
 */

import { createHotMemory, type HotMemory, type HotTurn, type Tier1Options } from "./hot/tier1";
import type { FactExtractor } from "./warm/extractor";
import type { WarmMemory } from "./warm/tier2";
import type { AnyFact } from "../types/facts";

/** Trusted DB foreign keys this manager's session writes under. */
export interface MemoryContext {
  orgId: string;
  sessionId: string;
}

/** A turn arriving at the manager. */
export interface IngestTurn {
  role: string;
  content: string;
  /** Unix ms timestamp. */
  timestamp: number;
}

/** What recall returns: the live hot window + durable warm facts. */
export interface RecallResult {
  hotTurns: HotTurn[];
  facts: AnyFact[];
}

export interface MemoryManager {
  /**
   * Add a turn to hot memory and drain any turns it evicted into warm memory
   * (extract → persist).
   * @param turn - the incoming turn.
   * @throws {Error} if a warm read/write in the drain fails (extraction discards
   *   invalid facts but does not throw).
   */
  ingest(turn: IngestTurn): Promise<void>;
  /**
   * Force a hot-window sweep and drain whatever it evicts (e.g. at session end).
   * @throws {Error} if the warm persist fails.
   */
  flush(): Promise<void>;
  /**
   * Read the current hot window + the durable facts from warm memory.
   * @param opts - max facts to return (default per WarmMemory.queryRecent).
   * @returns the hot turns + the warm facts (newest-first).
   * @throws {Error} if the warm read fails.
   */
  recall(opts?: { limit?: number }): Promise<RecallResult>;
  /** The underlying hot memory (for inspection / metrics). */
  hot: HotMemory;
}

export interface MemoryManagerDeps {
  extractor: FactExtractor;
  warm: WarmMemory;
  context: MemoryContext;
  /** Hot-memory options (window / clock); onEvict is supplied internally. */
  hotOptions?: Omit<Tier1Options, "onEvict">;
}

/**
 * Create a memory manager over the hot tier, fact extractor, and warm tier.
 *
 * @param deps - extractor + warm adapter + trusted session context + hot options.
 * @returns a {@link MemoryManager}.
 */
export function createMemoryManager(deps: MemoryManagerDeps): MemoryManager {
  // Evicted turns are buffered by the (synchronous) onEvict hook, then drained
  // asynchronously (extract + persist) after each ingest / on flush.
  const evictedBuffer: { role: string; content: string }[] = [];
  const hot = createHotMemory({
    ...(deps.hotOptions ?? {}),
    onEvict: (t: HotTurn) => {
      evictedBuffer.push({ role: t.role, content: typeof t.content === "string" ? t.content : JSON.stringify(t.content) });
    },
  });

  async function drain(): Promise<void> {
    if (evictedBuffer.length === 0) return;
    const turns = evictedBuffer.splice(0, evictedBuffer.length); // take the batch
    let facts: AnyFact[];
    try {
      facts = await deps.extractor.extract({ session_id: deps.context.sessionId, turns });
    } catch (err) {
      evictedBuffer.unshift(...turns); // extraction failed → re-queue; never lose evicted turns
      throw err;
    }
    if (facts.length === 0) return;
    // persist() does NOT throw — it returns per-table errors. If any table failed,
    // the facts are NOT durably stored, so re-queue the turns for the next drain
    // (rather than silently dropping them) and fail loud. persist upserts on id, so
    // a retry that re-persists already-stored facts is idempotent (no duplicates).
    const result = await deps.warm.persist(facts, { orgId: deps.context.orgId, sessionId: deps.context.sessionId });
    if (result.errors.length > 0) {
      evictedBuffer.unshift(...turns);
      throw new Error(`MemoryManager.drain: warm persist failed, turns re-queued: ${result.errors.map((e) => `${e.table}: ${e.message}`).join("; ")}`);
    }
  }

  return {
    hot,
    async ingest(turn: IngestTurn): Promise<void> {
      hot.add({ timestamp: turn.timestamp, role: turn.role, content: turn.content });
      await drain();
    },
    async flush(): Promise<void> {
      hot.sweep();
      await drain();
    },
    async recall(opts: { limit?: number } = {}): Promise<RecallResult> {
      const facts = await deps.warm.queryRecent(deps.context.orgId, {
        sessionId: deps.context.sessionId,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      return { hotTurns: hot.recent(), facts };
    },
  };
}
