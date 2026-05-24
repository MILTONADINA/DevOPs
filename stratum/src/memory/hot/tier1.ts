/**
 * Tier 1 — Hot Memory (RAM Rolling Window)
 *
 * Stores the last 2 hours of verbatim dialogue turns in RAM.
 * This is the primary input to KadaneDial.
 * Retrieval must be sub-millisecond.
 *
 * Eviction: When a turn's timestamp is older than now - 7200000ms,
 * it is evicted and sent to Tier 2 for fact extraction.
 */

// TODO: Implement Tier 1 hot memory (Phase 3)
