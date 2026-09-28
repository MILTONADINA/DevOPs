/**
 * Token Delta and Fee Calculator (Phase 6 / v1.0.0).
 *
 * Core calculation (BUSINESS_MODEL.md):
 *   token_delta  = original_tokens − quarantined_tokens
 *   cost_delta   = token_delta × api_price_per_token
 *   cq_fee       = cost_delta × arbitrage_rate        (default 20%)
 *
 * "The customer never pays more than they save" — so the fee FLOORS at 0 (a pathological
 * record where pruning grew the context never bills negative). Token counts must be exact
 * (from @anthropic-ai/sdk — never tiktoken); this module only does the arithmetic on them.
 */

/** Default arbitrage rate — 20% of savings (BUSINESS_MODEL.md). */
export const DEFAULT_ARBITRAGE_RATE = 0.2;

export interface FeeBreakdown {
  tokenDelta: number;
  costDeltaUsd: number;
  cqFeeUsd: number;
}

/**
 * Compute the token delta, cost delta, and CQ fee for one billing event.
 *
 * @param originalTokens - tokens the request would have cost unpruned (≥ 0).
 * @param quarantinedTokens - tokens after pruning (≥ 0).
 * @param apiPricePerToken - provider price per input token in USD (≥ 0).
 * @param arbitrageRate - fee fraction of savings, in [0, 1] (default {@link DEFAULT_ARBITRAGE_RATE}).
 * @returns the {@link FeeBreakdown} (cqFeeUsd floored at 0 — never bill negative).
 * @throws {Error} on a non-finite/negative input or an out-of-range rate.
 */
export function calculateFee(originalTokens: number, quarantinedTokens: number, apiPricePerToken: number, arbitrageRate: number = DEFAULT_ARBITRAGE_RATE): FeeBreakdown {
  if (!Number.isFinite(originalTokens) || originalTokens < 0) throw new Error("originalTokens must be a non-negative finite number");
  if (!Number.isFinite(quarantinedTokens) || quarantinedTokens < 0) throw new Error("quarantinedTokens must be a non-negative finite number");
  if (!Number.isFinite(apiPricePerToken) || apiPricePerToken < 0) throw new Error("apiPricePerToken must be a non-negative finite number");
  if (!Number.isFinite(arbitrageRate) || arbitrageRate < 0 || arbitrageRate > 1) throw new Error("arbitrageRate must be in [0, 1]");
  const tokenDelta = originalTokens - quarantinedTokens;
  const costDeltaUsd = tokenDelta * apiPricePerToken;
  const cqFeeUsd = Math.max(0, costDeltaUsd * arbitrageRate); // never bill more than they saved
  return { tokenDelta, costDeltaUsd, cqFeeUsd };
}
