// Tests for the HMAC-signed append-only billing recorder. NO live writes (billing_records
// is append-only and uncleanable) — recordBilling is tested with an injected fake client.

import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signBillingRecord, verifyBillingRecord, recordBilling, type BillingInput, type RecorderDeps } from "../../src/billing/recorder";

const SECRET = "test-billing-secret-please-rotate";
const INPUT: BillingInput = { sessionId: "s1", orgId: "o1", originalTokens: 50_000, quarantinedTokens: 7_500, apiPricePerToken: 0.000015, pruningLogId: "pl1" };

describe("signBillingRecord", () => {
  test("deterministic 64-hex HMAC; throws on an empty secret", () => {
    expect(signBillingRecord(INPUT, SECRET)).toBe(signBillingRecord(INPUT, SECRET));
    expect(signBillingRecord(INPUT, SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => signBillingRecord(INPUT, "")).toThrow(/secret/);
  });

  test("changes if ANY signed field changes (no field can be silently altered)", () => {
    const base = signBillingRecord(INPUT, SECRET);
    expect(signBillingRecord({ ...INPUT, originalTokens: 50_001 }, SECRET)).not.toBe(base);
    expect(signBillingRecord({ ...INPUT, quarantinedTokens: 7_501 }, SECRET)).not.toBe(base);
    expect(signBillingRecord({ ...INPUT, apiPricePerToken: 0.000016 }, SECRET)).not.toBe(base);
    expect(signBillingRecord({ ...INPUT, orgId: "o2" }, SECRET)).not.toBe(base);
    expect(signBillingRecord({ ...INPUT, sessionId: "s2" }, SECRET)).not.toBe(base);
    expect(signBillingRecord({ ...INPUT, pruningLogId: "pl2" }, SECRET)).not.toBe(base);
    expect(signBillingRecord(INPUT, "other-secret")).not.toBe(base);
  });

  test("field boundaries are unambiguous (no concatenation collision across fields)", () => {
    // "12|3" vs "1|23" style collisions must not produce equal signatures.
    const a = signBillingRecord({ ...INPUT, orgId: "ab", sessionId: "c" }, SECRET);
    const b = signBillingRecord({ ...INPUT, orgId: "a", sessionId: "bc" }, SECRET);
    expect(a).not.toBe(b);
  });
});

describe("verifyBillingRecord", () => {
  const hash = signBillingRecord(INPUT, SECRET);

  test("accepts an untampered record", () => {
    expect(verifyBillingRecord(INPUT, hash, SECRET)).toBe(true);
  });
  test("rejects tampered inputs, wrong secret, and malformed/short hashes", () => {
    expect(verifyBillingRecord({ ...INPUT, originalTokens: 999_999 }, hash, SECRET)).toBe(false);
    expect(verifyBillingRecord(INPUT, hash, "wrong-secret")).toBe(false);
    expect(verifyBillingRecord(INPUT, "deadbeef", SECRET)).toBe(false); // wrong length
    expect(verifyBillingRecord(INPUT, "z".repeat(64), SECRET)).toBe(false); // non-hex
  });
});

describe("recordBilling", () => {
  function fakeClient(opts: { error?: string } = {}): { client: SupabaseClient; captured: { table?: string; row?: Record<string, unknown> } } {
    const captured: { table?: string; row?: Record<string, unknown> } = {};
    const client = {
      from(table: string) {
        captured.table = table;
        return {
          insert(row: Record<string, unknown>) {
            captured.row = row;
            return { select: () => ({ limit: () => Promise.resolve(opts.error ? { data: null, error: { message: opts.error } } : { data: [{ id: "rec-1" }], error: null }) }) };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, captured };
  }

  test("signs + inserts the inputs (NOT the generated columns) and returns id + fee", async () => {
    const { client, captured } = fakeClient();
    const res = await recordBilling({ client, secret: SECRET } as RecorderDeps, INPUT);
    expect(captured.table).toBe("billing_records");
    expect(captured.row).toMatchObject({
      session_id: "s1",
      org_id: "o1",
      original_tokens: 50_000,
      quarantined_tokens: 7_500,
      api_price_per_token: 0.000015,
      pruning_log_id: "pl1",
      signed_hash: signBillingRecord(INPUT, SECRET),
    });
    // generated columns must NOT be sent (the DB computes them)
    expect(captured.row).not.toHaveProperty("token_delta");
    expect(captured.row).not.toHaveProperty("cost_delta_usd");
    expect(captured.row).not.toHaveProperty("cq_fee_usd");
    expect(res.id).toBe("rec-1");
    expect(res.cqFeeUsd).toBeCloseTo(0.1275, 6); // raw float fee (the invoice rounds, not the calculator)
    // and the stored row verifies
    expect(verifyBillingRecord(INPUT, captured.row!["signed_hash"] as string, SECRET)).toBe(true);
  });

  test("omits pruning_log_id when not provided", async () => {
    const { client, captured } = fakeClient();
    const { pruningLogId: _drop, ...noPl } = INPUT;
    await recordBilling({ client, secret: SECRET } as RecorderDeps, noPl);
    expect(captured.row).not.toHaveProperty("pruning_log_id");
  });

  test("a DB error throws", async () => {
    const { client } = fakeClient({ error: "insert blocked" });
    await expect(recordBilling({ client, secret: SECRET } as RecorderDeps, INPUT)).rejects.toThrow(/recordBilling failed: insert blocked/);
  });
});
