/**
 * Anthropic input-token list prices → per-token USD (Phase 6 / v1.0.0).
 *
 * A billing_record needs `api_price_per_token` (the provider's per-INPUT-token price; pruning saves
 * INPUT context). This maps a model id to that price. The fee only depends on the price when pruning
 * is active (token_delta > 0); until then token_delta = 0 ⇒ fee = $0 regardless of price, so recording
 * usage now needs no exact price — but the value is stored on every record, so it must be HONEST:
 *
 *   - These are PUBLIC LIST prices (per million input tokens), not fabricated precision. They change,
 *     and a design partner may have a negotiated rate, so the source of truth is the operator: set
 *     CQ_INPUT_PRICE_PER_TOKEN (USD per token) to override for ALL models. VERIFY the rate before any
 *     savings-based (pruning-active) billing.
 *
 * Pure + env-injectable (the env is passed in, never read globally) so it is fully unit-tested.
 */

/** Public list prices, USD per MILLION input tokens, by model family (substring match). */
const LIST_PRICE_PER_MILLION_INPUT: ReadonlyArray<{ match: RegExp; perMillionUsd: number }> = [
  { match: /opus/i, perMillionUsd: 15 },
  { match: /sonnet/i, perMillionUsd: 3 },
  { match: /haiku-3|haiku-3-5|haiku-3\.5/i, perMillionUsd: 0.8 },
  { match: /haiku/i, perMillionUsd: 1 },
];

/** Fallback when no family matches — Sonnet-tier (the workhorse), so an unknown model is never $0. */
const DEFAULT_PER_MILLION_INPUT = 3;

/**
 * Resolve the per-input-token price (USD) for a model.
 *
 * @param model - the Anthropic model id (e.g. "claude-opus-4-8").
 * @param env - environment (reads CQ_INPUT_PRICE_PER_TOKEN as a global override). Injected for tests.
 * @returns USD per input token (always > 0 — the billing_records CHECK requires it).
 */
export function pricePerInputTokenUsd(model: string, env: { CQ_INPUT_PRICE_PER_TOKEN?: string | undefined } = process.env): number {
  const override = env.CQ_INPUT_PRICE_PER_TOKEN;
  if (override !== undefined && override.trim() !== "") {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n; // operator-set rate (e.g. a negotiated price) wins
  }
  const family = LIST_PRICE_PER_MILLION_INPUT.find((p) => p.match.test(model));
  const perMillion = family ? family.perMillionUsd : DEFAULT_PER_MILLION_INPUT;
  return perMillion / 1_000_000;
}
