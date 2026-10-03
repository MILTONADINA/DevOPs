// The usage summary's totals (specs/ops/payment-removal.md REQ-3, REQ-6): token totals, pruning effectiveness, the distinct session count and an ESTIMATED USD cost difference,
// computed by a pure module that imports nothing under src/billing/. Every expectation is a literal, never the result of another implementation, so a change to the rounding or to
// the effectiveness rule has to change a number here.

import { describe, test, expect } from "vitest";
import { summarizeUsage, type UsageRecord } from "../../src/usage/summary";

/** One usage record: 50,000 original and 7,500 quarantined tokens, an estimated cost difference of 0.6375. */
const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({ session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, ...overrides });

describe("summarizeUsage", () => {
  // Mutation: dropping round2 from total_cost_delta_usd (0.6375 would come back unrounded).
  test("specs/ops/payment-removal.md#AC-6 50,000 original and 7,500 quarantined tokens give 85% effectiveness and an estimated cost delta of 0.64 (regression guard)", () => {
    expect(summarizeUsage([record()])).toEqual({
      total_original_tokens: 50_000,
      total_quarantined_tokens: 7_500,
      total_token_delta: 42_500,
      total_cost_delta_usd: 0.64,
      total_sessions: 1,
      average_pruning_effectiveness_pct: 85,
    });
  });

  // Mutation: dropping Number.EPSILON from round2 (1.275 * 100 is 127.49999999999999, so the cost delta would round down to 1.27).
  test("specs/ops/payment-removal.md#AC-6 cost deltas summing to 1.275 round up to 1.28, not down to 1.27 (regression guard)", () => {
    const summary = summarizeUsage([record({ session_id: "s1" }), record({ session_id: "s2" })]);
    expect(summary.total_cost_delta_usd).toBe(1.28);
  });

  // Mutation: dropping the zero-token guard (0 / 0 is NaN, so the effectiveness would not be 0).
  test("specs/ops/payment-removal.md#AC-6 a month with no records has 0% effectiveness and a 0 cost delta (regression guard)", () => {
    expect(summarizeUsage([])).toEqual({
      total_original_tokens: 0,
      total_quarantined_tokens: 0,
      total_token_delta: 0,
      total_cost_delta_usd: 0,
      total_sessions: 0,
      average_pruning_effectiveness_pct: 0,
    });
  });

  // C3 preservation: clamping retained token/cost deltas to the retired fee floor would lose this negative usage.
  test("specs/ops/payment-removal.md#AC-6 increased token usage remains a negative delta and USD estimate (regression guard)", () => {
    expect(summarizeUsage([record({ original_tokens: 1_000, quarantined_tokens: 4_000, cost_delta_usd: -0.06 })])).toEqual({
      total_original_tokens: 1_000,
      total_quarantined_tokens: 4_000,
      total_token_delta: -3_000,
      total_cost_delta_usd: -0.06,
      total_sessions: 1,
      average_pruning_effectiveness_pct: -300,
    });
  });

  // C3 preservation: rounding each 0.025 row first yields 0.60 instead of rounding the raw sum to 0.50.
  test("specs/ops/payment-removal.md#AC-6 USD estimates sum raw deltas before rounding the total (regression guard)", () => {
    const records = Array.from({ length: 20 }, (_, i) => record({ session_id: `s${i}`, cost_delta_usd: 0.025 }));
    expect(summarizeUsage(records).total_cost_delta_usd).toBe(0.5);
  });

  // Mutation: rounding the token totals to cents. Token counts are whole numbers in practice; these are exact binary fractions, so any rounding of a total or of the delta shows.
  test("specs/ops/payment-removal.md#AC-6 token totals are the plain sums and are never rounded (regression guard)", () => {
    const summary = summarizeUsage([
      { session_id: "s1", original_tokens: 1000.125, quarantined_tokens: 500.5, cost_delta_usd: 0 },
      { session_id: "s2", original_tokens: 2000.0625, quarantined_tokens: 100.25, cost_delta_usd: 0 },
    ]);
    expect(summary.total_original_tokens).toBe(3000.1875);
    expect(summary.total_quarantined_tokens).toBe(600.75);
    expect(summary.total_token_delta).toBe(2399.4375);
  });

  // Mutation: counting records instead of distinct session_id values (this fixture would give 3).
  test("specs/ops/payment-removal.md#AC-6 total_sessions counts distinct session ids, not records (regression guard)", () => {
    const summary = summarizeUsage([record({ session_id: "s1" }), record({ session_id: "s1" }), record({ session_id: "s2" })]);
    expect(summary.total_sessions).toBe(2);
  });
});
