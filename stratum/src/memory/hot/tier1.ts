/**
 * Tier 1 — Hot Memory (RAM Rolling Window) — Phase 3 / v0.5.x.
 *
 * The last `windowMs` (default 2h) of verbatim dialogue turns, in RAM. This is
 * the primary input to the KadaneDial pruner (src/pruner): each turn is stored
 * with its L2-normalized embedding (computed once at ingestion), so pruning
 * reads embeddings straight from here. Retrieval is O(n) over the in-window
 * turns (a few hundred at most) — sub-ms in practice.
 *
 * Eviction: a turn older than `now - windowMs` is dropped from the window and
 * handed to `onEvict` (the Phase-3 hand-off to Tier-2 fact extraction). This
 * module is PURE in-memory (no DB/account) and fully unit-tested; the Tier-2/3
 * adapters it feeds (Supabase / Neo4j / Pinecone) are gated on those services.
 */

/** One dialogue turn held in the hot window. */
export interface HotTurn {
  /** Unix ms timestamp when the turn occurred. */
  timestamp: number;
  role: string;
  /** Turn content (string or Anthropic content blocks). */
  content: unknown;
  /** L2-normalized embedding computed at ingestion (what the pruner consumes). */
  embedding?: Float32Array;
}

export interface Tier1Options {
  /** Rolling-window size in ms (default 2h = 7_200_000). */
  windowMs?: number;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
  /** Called for each turn evicted past the window (→ Tier-2 fact extraction). */
  onEvict?: (turn: HotTurn) => void;
}

export interface HotMemory {
  /** Append a turn, then evict any now-stale turns (calling onEvict for each). */
  add(turn: HotTurn): void;
  /**
   * Force an eviction sweep. Pass `atMs` to evict against a specific time
   * (e.g. the caller's clock for deterministic batch/replay) instead of the
   * store's own clock — so eviction and a separately-supplied decay time agree.
   */
  sweep(atMs?: number): void;
  /** In-window turns, oldest → newest (the pruner's history input). */
  recent(): HotTurn[];
  /** Number of in-window turns. */
  size(): number;
}

const TWO_HOURS_MS = 7_200_000;

/**
 * Create a Tier-1 hot-memory window.
 *
 * @param opts - window size / clock / eviction hook.
 * @returns a {@link HotMemory}.
 */
export function createHotMemory(opts: Tier1Options = {}): HotMemory {
  const windowMs = opts.windowMs ?? TWO_HOURS_MS;
  const now = opts.now ?? (() => Date.now());
  const onEvict = opts.onEvict;
  // Turns are kept in ascending timestamp order; eviction is always from the front.
  const turns: HotTurn[] = [];

  function evictStale(atMs?: number): void {
    const cutoff = (atMs ?? now()) - windowMs;
    let i = 0;
    while (i < turns.length && (turns[i]?.timestamp ?? Infinity) < cutoff) i++;
    if (i > 0) {
      const evicted = turns.splice(0, i);
      if (onEvict) for (const t of evicted) onEvict(t);
    }
  }

  return {
    add(turn: HotTurn): void {
      // Keep ascending order even if a turn arrives slightly out of order.
      if (turns.length > 0 && turn.timestamp < (turns[turns.length - 1]?.timestamp ?? 0)) {
        let lo = 0;
        let hi = turns.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((turns[mid]?.timestamp ?? 0) <= turn.timestamp) lo = mid + 1;
          else hi = mid;
        }
        turns.splice(lo, 0, turn);
      } else {
        turns.push(turn);
      }
      evictStale();
    },
    sweep(atMs?: number): void {
      evictStale(atMs);
    },
    recent(): HotTurn[] {
      return turns.slice();
    },
    size(): number {
      return turns.length;
    },
  };
}
