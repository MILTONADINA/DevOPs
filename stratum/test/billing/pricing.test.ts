// Tests for the input-token pricing resolver (operator-configurable, list-price defaults).

import { describe, test, expect } from "vitest";
import { pricePerInputTokenUsd } from "../../src/billing/pricing";

describe("pricePerInputTokenUsd", () => {
  test("maps model families to per-token list prices (per-million ÷ 1e6)", () => {
    expect(pricePerInputTokenUsd("claude-opus-4-8", {})).toBeCloseTo(15 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-sonnet-4-6", {})).toBeCloseTo(3 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-haiku-4-5", {})).toBeCloseTo(1 / 1_000_000, 12);
  });

  test("Haiku 4.x bills at $1.00/M input (NOT $0.80 like 3.5) — audit regression guard", () => {
    // Verified list price (platform.claude.com pricing, 2026-05-30). A 2026 audit finding mistakenly
    // proposed $0.80/M for Haiku 4.5, which would UNDER-bill the savings fee by 20%. Pin it so a future
    // "fix" can't silently re-introduce that error.
    expect(pricePerInputTokenUsd("claude-haiku-4-5", {})).toBeCloseTo(1 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-haiku-4-5-20251001", {})).toBeCloseTo(1 / 1_000_000, 12);
    // The older Haiku 3.x family is the $0.80/M tier (matched via the haiku-3 entry).
    expect(pricePerInputTokenUsd("claude-haiku-3-5", {})).toBeCloseTo(0.8 / 1_000_000, 12);
  });

  test("OpenAI gpt-5.x families map to verified list prices (mini/nano before the generic gpt-5)", () => {
    expect(pricePerInputTokenUsd("gpt-5.5", {})).toBeCloseTo(5 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("gpt-5.4", {})).toBeCloseTo(2.5 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("gpt-5.4-mini", {})).toBeCloseTo(0.75 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("gpt-5.4-nano", {})).toBeCloseTo(0.2 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("openai/gpt-5.4-mini", {})).toBeCloseTo(0.75 / 1_000_000, 12); // prefix-tolerant
  });

  test("Gemini families map to verified base-tier list prices", () => {
    expect(pricePerInputTokenUsd("gemini-2.5-pro", {})).toBeCloseTo(1.25 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("gemini-2.5-flash", {})).toBeCloseTo(0.3 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("gemini-2.0-flash", {})).toBeCloseTo(0.1 / 1_000_000, 12);
  });

  test("an unknown model falls back to the workhorse (Sonnet) tier — never $0", () => {
    const p = pricePerInputTokenUsd("some-future-model", {});
    expect(p).toBeGreaterThan(0);
    expect(p).toBeCloseTo(3 / 1_000_000, 12);
  });

  test("CQ_INPUT_PRICE_PER_TOKEN overrides for all models (a negotiated rate)", () => {
    expect(pricePerInputTokenUsd("claude-opus-4-8", { CQ_INPUT_PRICE_PER_TOKEN: "0.000002" })).toBe(0.000002);
    // a non-numeric / non-positive override is ignored (falls back to the map)
    expect(pricePerInputTokenUsd("claude-opus-4-8", { CQ_INPUT_PRICE_PER_TOKEN: "nope" })).toBeCloseTo(15 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-opus-4-8", { CQ_INPUT_PRICE_PER_TOKEN: "0" })).toBeCloseTo(15 / 1_000_000, 12);
  });

  test("the result is always > 0 (billing_records CHECK api_price_per_token > 0)", () => {
    for (const m of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "x", ""]) {
      expect(pricePerInputTokenUsd(m, {})).toBeGreaterThan(0);
    }
  });
});
