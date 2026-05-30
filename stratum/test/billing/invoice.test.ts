// Unit tests for the token-arbitrage billing engine (pure). Numbers cross-checked
// against docs/BUSINESS_MODEL.md (fractional-CTO scenario: 50k→7.5k tokens @ $0.000015).

import { describe, test, expect } from "vitest";
import { calculateFee, DEFAULT_ARBITRAGE_RATE } from "../../src/billing/calculator";
import { generateInvoice, toAuditCsv, renderInvoice, type BillableRecord } from "../../src/billing/invoice";
import { createFakeInvoiceSink, createStripeInvoiceSink } from "../../src/billing/stripe-sink";

describe("calculateFee", () => {
  test("BUSINESS_MODEL per-session figures: 50k→7.5k @ $0.000015, 20% fee", () => {
    const f = calculateFee(50_000, 7_500, 0.000015);
    expect(f.tokenDelta).toBe(42_500);
    expect(f.costDeltaUsd).toBeCloseTo(0.6375, 6);
    expect(f.cqFeeUsd).toBeCloseTo(0.1275, 6); // 0.6375 × 0.20
    expect(DEFAULT_ARBITRAGE_RATE).toBe(0.2);
  });

  test("never bills negative — quarantined > original floors the fee at 0", () => {
    const f = calculateFee(1_000, 4_000, 0.000015);
    expect(f.tokenDelta).toBe(-3_000);
    expect(f.cqFeeUsd).toBe(0); // floored, even though cost delta is negative
  });

  test("a custom arbitrage rate is honored", () => {
    expect(calculateFee(50_000, 7_500, 0.000015, 0.15).cqFeeUsd).toBeCloseTo(0.6375 * 0.15, 6);
  });

  test("fail-loud on bad inputs", () => {
    expect(() => calculateFee(-1, 0, 0.000015)).toThrow(/originalTokens/);
    expect(() => calculateFee(100, -1, 0.000015)).toThrow(/quarantinedTokens/);
    expect(() => calculateFee(100, 50, -1)).toThrow(/apiPricePerToken/);
    expect(() => calculateFee(100, 50, 0.000015, 1.5)).toThrow(/arbitrageRate/);
  });
});

describe("generateInvoice", () => {
  const recs: BillableRecord[] = [
    { session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h1" },
    { session_id: "s2", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275, signed_hash: "h2" },
  ];

  test("aggregates totals, fee, and 85% effectiveness", () => {
    const inv = generateInvoice("org1", "starter", recs, "2026-05-01", "2026-05-31");
    expect(inv.recordCount).toBe(2);
    expect(inv.totalOriginalTokens).toBe(100_000);
    expect(inv.totalQuarantinedTokens).toBe(15_000);
    expect(inv.effectivenessPct).toBe(85); // (100k − 15k) / 100k
    expect(inv.totalSavingsUsd).toBe(1.28); // round2(1.275)
    expect(inv.rawFeeUsd).toBe(0.26); // round2(0.255)
    expect(inv.amountDueUsd).toBe(0.26); // starter minimum $0 → the fee
    expect(inv.lineItems).toHaveLength(2);
    expect(inv.lineItems[0]).toMatchObject({ sessionId: "s1", savingsUsd: 0.64, feeUsd: 0.13 });
  });

  test("the monthly minimum floors the amount due (growth plan, tiny usage)", () => {
    const inv = generateInvoice("org1", "growth", recs, "p0", "p1");
    expect(inv.monthlyMinimumUsd).toBe(99);
    expect(inv.amountDueUsd).toBe(99); // max($99 minimum, $0.26 fee)
  });

  test("empty period: $0 for starter, the minimum for growth; never NaN effectiveness", () => {
    expect(generateInvoice("o", "starter", [], "a", "b").amountDueUsd).toBe(0);
    expect(generateInvoice("o", "starter", [], "a", "b").effectivenessPct).toBe(0); // not NaN (0/0 guarded)
    expect(generateInvoice("o", "growth", [], "a", "b").amountDueUsd).toBe(99);
  });

  test("an unknown plan has no minimum (treated as $0 floor)", () => {
    expect(generateInvoice("o", "mystery", recs, "a", "b").monthlyMinimumUsd).toBe(0);
  });
});

describe("toAuditCsv", () => {
  test("header + a row per record, with the signed hash", () => {
    const csv = toAuditCsv([{ session_id: "s1", original_tokens: 100, quarantined_tokens: 40, cost_delta_usd: 0.5, cq_fee_usd: 0.1, signed_hash: "abc" }]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("session_id,original_tokens,quarantined_tokens,cost_delta_usd,cq_fee_usd,signed_hash");
    expect(lines[1]).toBe("s1,100,40,0.5,0.1,abc");
  });
  test("escapes a field containing a comma", () => {
    const csv = toAuditCsv([{ session_id: "a,b", original_tokens: 1, quarantined_tokens: 0, cost_delta_usd: 0, cq_fee_usd: 0 }]);
    expect(csv.split("\n")[1]).toBe('"a,b",1,0,0,0,'); // quoted; empty hash trailing
  });
});

describe("renderInvoice", () => {
  test("includes the amount due and effectiveness", () => {
    const inv = generateInvoice("org1", "starter", [{ session_id: "s1", original_tokens: 50_000, quarantined_tokens: 7_500, cost_delta_usd: 0.6375, cq_fee_usd: 0.1275 }], "a", "b");
    const r = renderInvoice(inv);
    expect(r).toMatch(/AMOUNT DUE:\s+\$0\.13/);
    expect(r).toMatch(/effectiveness:\s+85\.0%/);
  });
});

describe("invoice sinks", () => {
  const inv = generateInvoice("org1", "starter", [], "a", "b");

  test("the fake sink records what it was asked to send", async () => {
    const sink = createFakeInvoiceSink();
    const receipt = await sink.send(inv);
    expect(sink.sent).toEqual([inv]);
    expect(receipt).toMatchObject({ status: "draft", amountUsd: 0 });
    expect(receipt.id).toMatch(/^fake_inv_/);
  });

  test("the real Stripe sink rejects without a key (gated)", async () => {
    await expect(createStripeInvoiceSink({ secretKey: "" }).send(inv)).rejects.toThrow(/STRIPE_SECRET_KEY is empty/);
  });
});
