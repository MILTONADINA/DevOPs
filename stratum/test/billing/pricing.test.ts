// Tests for the input-token pricing resolver (operator-configurable, list-price defaults).

import { describe, test, expect } from "vitest";
import { pricePerInputTokenUsd } from "../../src/billing/pricing";

describe("pricePerInputTokenUsd", () => {
  test("maps model families to per-token list prices (per-million ÷ 1e6)", () => {
    expect(pricePerInputTokenUsd("claude-opus-4-8", {})).toBeCloseTo(15 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-sonnet-4-6", {})).toBeCloseTo(3 / 1_000_000, 12);
    expect(pricePerInputTokenUsd("claude-haiku-4-5", {})).toBeCloseTo(1 / 1_000_000, 12);
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
