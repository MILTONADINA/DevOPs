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
 * WarmMemory). The deterministic hot+warm path needs no encoder. Tier-3 SEMANTIC
 * recall is now an OPT-IN layer: pass a VectorStore + (offline ONNX) encoder in deps
 * and recall({query}) also returns vector-search neighbours resolved to facts — no
 * Anthropic, on the Supabase/pgvector store (ADR-0013). Omit them for hot+warm only.
 */

import { createHotMemory, type HotMemory, type HotTurn, type Tier1Options } from "./hot/tier1";
import type { FactExtractor } from "./warm/extractor";
import type { WarmMemory } from "./warm/tier2";
import type { VectorStore } from "./cold/vectors";
import type { BiEncoder } from "../pruner/encoder";
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
  /**
   * Tier-3 SEMANTIC recall: vector-search neighbours resolved to their typed facts,
   * most-similar first. Present only when a `query` is given AND a vector store +
   * encoder are configured (deps). Uses the OFFLINE encoder — no Anthropic.
   */
  relevantFacts?: AnyFact[];
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
   * Read the current hot window + the durable facts from warm memory; optionally
   * also semantic neighbours for a query (Tier-3 vector search → resolved facts).
   * @param opts - `limit` (recent warm facts), `query` (semantic recall — needs a
   *   vector store + encoder in deps), `k` (max semantic neighbours, default 5).
   * @returns hot turns + warm facts (newest-first) + (if a query) relevant facts.
   * @throws {Error} if the warm read or a configured semantic step fails.
   */
  recall(opts?: { limit?: number; query?: string; k?: number }): Promise<RecallResult>;
  /** The underlying hot memory (for inspection / metrics). */
  hot: HotMemory;
}

export interface MemoryManagerDeps {
  extractor: FactExtractor;
  warm: WarmMemory;
  context: MemoryContext;
  /** Hot-memory options (window / clock); onEvict is supplied internally. */
  hotOptions?: Omit<Tier1Options, "onEvict">;
  /**
   * OPT-IN Tier-3 semantic recall. When BOTH are set, `recall({query})` also returns
   * `relevantFacts` — vector-search neighbours resolved to facts. The encoder is the
   * LOCAL ONNX one (no Anthropic); omit both for the deterministic hot+warm path only.
   */
  vectors?: VectorStore;
  encoder?: BiEncoder;
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
  // Facts that were extracted but whose persist FAILED on a prior drain. They are re-persisted with
  // their ORIGINAL minted ids, so the upsert-on-id retry is genuinely idempotent. Re-queuing the raw
  // TURNS instead (and re-extracting) would mint BRAND-NEW ids → duplicate facts for every table that
  // already succeeded in the partial failure.
  const pendingFacts: AnyFact[] = [];
  const hot = createHotMemory({
    ...(deps.hotOptions ?? {}),
    onEvict: (t: HotTurn) => {
      evictedBuffer.push({ role: t.role, content: typeof t.content === "string" ? t.content : JSON.stringify(t.content) });
    },
  });

  const persistCtx = (): { orgId: string; sessionId: string } => ({ orgId: deps.context.orgId, sessionId: deps.context.sessionId });

  async function drain(): Promise<void> {
    // 1) Re-persist any facts from a prior failed drain FIRST — same ids ⇒ the upsert is idempotent
    //    (re-persisting an already-stored fact overwrites its own row; no duplicate is created).
    if (pendingFacts.length > 0) {
      const retry = pendingFacts.splice(0, pendingFacts.length);
      const r = await deps.warm.persist(retry, persistCtx());
      if (r.errors.length > 0) {
        pendingFacts.unshift(...retry); // still failing → keep the EXACT facts (ids stable) for next time
        throw new Error(`MemoryManager.drain: warm re-persist failed, facts re-queued: ${r.errors.map((e) => `${e.table}: ${e.message}`).join("; ")}`);
      }
    }

    if (evictedBuffer.length === 0) return;
    const turns = evictedBuffer.splice(0, evictedBuffer.length); // take the batch
    let facts: AnyFact[];
    try {
      facts = await deps.extractor.extract({ session_id: deps.context.sessionId, turns });
    } catch (err) {
      evictedBuffer.unshift(...turns); // extraction failed → re-queue turns (NO ids minted yet, safe)
      throw err;
    }
    if (facts.length === 0) return;
    // persist() does NOT throw — it returns per-table errors. On a partial failure, re-queue the
    // EXTRACTED FACTS (with their already-minted ids), NOT the turns — so the next drain re-presents
    // the SAME ids and the upsert dedups instead of minting duplicates from a fresh extraction.
    const result = await deps.warm.persist(facts, persistCtx());
    if (result.errors.length > 0) {
      pendingFacts.push(...facts);
      throw new Error(`MemoryManager.drain: warm persist failed, facts re-queued: ${result.errors.map((e) => `${e.table}: ${e.message}`).join("; ")}`);
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
    async recall(opts: { limit?: number; query?: string; k?: number } = {}): Promise<RecallResult> {
      const facts = await deps.warm.queryRecent(deps.context.orgId, {
        sessionId: deps.context.sessionId,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      const result: RecallResult = { hotTurns: hot.recent(), facts };

      // Tier-3 semantic recall (opt-in): encode the query offline → vector search →
      // resolve the content-free hits to their typed facts, preserving similarity order.
      if (opts.query !== undefined && deps.vectors && deps.encoder) {
        const [qVec] = await deps.encoder.encode([opts.query]);
        if (qVec) {
          const matches = await deps.vectors.search(deps.context.orgId, Array.from(qVec), opts.k ?? 5);
          const refs = matches.map((m) => m.sourceRef).filter((r): r is string => typeof r === "string" && r.length > 0);
          const byId = await deps.warm.getFactsByRefs(deps.context.orgId, refs);
          const relevantFacts: AnyFact[] = [];
          for (const m of matches) {
            const f = m.sourceRef ? byId.get(m.sourceRef) : undefined;
            if (f) relevantFacts.push(f);
          }
          result.relevantFacts = relevantFacts;
        }
      }
      return result;
    },
  };
}
