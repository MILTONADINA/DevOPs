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
// USD per MTok INPUT, by model family (substring + case-insensitive; FIRST match wins, so specific
// entries precede generic ones). MULTI-PROVIDER (ADR-0019): Anthropic, OpenAI, and Gemini families have
// verified list prices; OpenRouter/local and any unmatched model fall to the conservative default and
// SHOULD set CQ_INPUT_PRICE_PER_TOKEN. The fee only depends on this once pruning is active (token_delta>0);
// until then token_delta=0 ⇒ fee $0 regardless, but the value is recorded so it must be honest.
//
// Verified 2026-05-30: Anthropic (platform.claude.com) Opus 4.x $15, Sonnet $3, Haiku 3/3.5 $0.80,
// Haiku 4.5 $1.00 (Haiku 4.x is listed EXPLICITLY — it is $1.00, NOT $0.80 like 3.5; a 2026 audit finding
// mistakenly proposed $0.80, a 20% under-bill — see the regression test). OpenAI (developers.openai.com)
// gpt-5.5 $5, gpt-5.4 $2.50, gpt-5.4-mini $0.75, gpt-5.4-nano $0.20. Gemini (ai.google.dev) 2.5-pro $1.25
// (≤200k base tier), 2.5-flash $0.30, 2.0-flash $0.10.
const LIST_PRICE_PER_MILLION_INPUT: ReadonlyArray<{ match: RegExp; perMillionUsd: number }> = [
  // Anthropic
  { match: /opus/i, perMillionUsd: 15 },
  { match: /sonnet/i, perMillionUsd: 3 },
  { match: /haiku-3/i, perMillionUsd: 0.8 }, // Haiku 3 / 3.5
  { match: /haiku-4/i, perMillionUsd: 1 }, // Haiku 4.x — verified $1.00/M (NOT $0.80)
  { match: /haiku/i, perMillionUsd: 1 }, // unknown future Haiku → conservative $1.00/M
  // OpenAI (gpt-5.x current lineup; mini/nano BEFORE the generic gpt-5)
  { match: /gpt-5\.?4-nano|gpt-5-nano/i, perMillionUsd: 0.2 },
  { match: /gpt-5\.?4-mini|gpt-5-mini/i, perMillionUsd: 0.75 },
  { match: /gpt-5\.?5/i, perMillionUsd: 5 },
  { match: /gpt-5/i, perMillionUsd: 2.5 }, // gpt-5.4 base + generic gpt-5
  { match: /gpt|chatgpt|^o[0-9]/i, perMillionUsd: 2.5 }, // other/legacy OpenAI → conservative; override via CQ_INPUT_PRICE_PER_TOKEN
  // Gemini (base/≤200k tier)
  { match: /gemini-2\.5-pro/i, perMillionUsd: 1.25 },
  { match: /gemini-2\.5-flash/i, perMillionUsd: 0.3 },
  { match: /gemini-2\.0-flash/i, perMillionUsd: 0.1 },
  { match: /gemini/i, perMillionUsd: 1.25 }, // unknown Gemini → 2.5-pro base
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
