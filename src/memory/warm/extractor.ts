/**
 * Fact Extractor — Llama 4-8B Structured Extraction
 *
 * Processes evicted Tier 1 turns and extracts typed structured facts.
 * Uses Llama 4-8B for cost efficiency (~$0.001/extraction).
 * Output is Zod-validated before any DB write.
 *
 * NEVER use GPT-4 or Opus for extraction — this runs on every turn.
 * Invalid outputs are discarded, not retried.
 */

// TODO: Implement fact extraction (Phase 3)
