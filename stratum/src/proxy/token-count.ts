/**
 * Exact token counting with a hash-keyed cache + honest fallback (§2d).
 *
 * Phase 1 billing accuracy depends on PROVABLE token counts, so the primary
 * path is the Anthropic SDK's exact countTokens endpoint. Two hardenings:
 *
 *   1. Hash cache — Claude Code re-sends overlapping context every turn;
 *      identical count-relevant payloads (model + messages + system + tools)
 *      are counted once and reused (bounded LRU).
 *   2. Honest fallback — if countTokens errors, we NEVER silently report
 *      "exact". We return a clearly-flagged heuristic estimate
 *      (token_count_method:"estimated"). NOTE: @anthropic-ai/tokenizer was
 *      removed Session 13 (unpublished), so the fallback is a chars/4 heuristic
 *      — coarse but honestly labeled; downstream billing must treat "estimated"
 *      turns as non-provable.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesBody, TokenCountResult } from "./forward";

export interface TokenCounter {
  count(body: MessagesBody): Promise<TokenCountResult>;
}

export interface TokenCounterOptions {
  /** Max cached EXACT counts (LRU). Default 256. */
  maxCacheEntries?: number;
}

/** Stable cache key over the fields that determine the count. */
function stableKey(body: MessagesBody): string {
  return JSON.stringify({
    model: body.model,
    messages: body.messages,
    system: body.system ?? null,
    tools: body.tools ?? null,
  });
}

/** Coarse fallback estimate (~chars/4). Always flagged "estimated", never exact. */
function estimateTokens(body: MessagesBody): number {
  const text = JSON.stringify(body.messages ?? "") + JSON.stringify(body.system ?? "") + JSON.stringify(body.tools ?? "");
  return Math.ceil(text.length / 4);
}

/**
 * Create a caching token counter.
 *
 * @param client - the Anthropic SDK client (its countTokens is the exact path).
 * @param opts - cache sizing.
 * @returns a {@link TokenCounter}.
 */
export function createTokenCounter(client: Anthropic, opts: TokenCounterOptions = {}): TokenCounter {
  const max = opts.maxCacheEntries ?? 256;
  const cache = new Map<string, TokenCountResult>();

  return {
    async count(body: MessagesBody): Promise<TokenCountResult> {
      const key = stableKey(body);
      const cached = cache.get(key);
      if (cached) {
        // Refresh LRU recency.
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }

      let result: TokenCountResult;
      try {
        const r = await client.messages.countTokens({
          model: body.model,
          messages: body.messages as Anthropic.MessageParam[],
          ...(body.system !== undefined ? { system: body.system as string } : {}),
          ...(body.tools !== undefined ? { tools: body.tools as Anthropic.Tool[] } : {}),
        });
        result = { input_tokens: r.input_tokens, token_count_method: "exact", message_breakdown: [] };
      } catch {
        // FALLBACK — flagged, never silently exact.
        result = {
          input_tokens: estimateTokens(body),
          token_count_method: "estimated",
          message_breakdown: [],
        };
      }

      // Only cache EXACT results — estimates are cheap and may resolve to exact
      // on a later retry once the SDK is healthy.
      if (result.token_count_method === "exact") {
        cache.set(key, result);
        if (cache.size > max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      return result;
    },
  };
}
