// Tests for verify-stripe's key classifier (the gated-skip / live-refusal logic). The live send is
// manual + gated on a real test key; this pins the branch that decides skip vs. refuse vs. run.

import { describe, test, expect } from "vitest";
import { classifyStripeKey } from "../../scripts/verify-stripe";

describe("classifyStripeKey", () => {
  test("missing / empty / placeholder → 'missing' (gated-skip, never fabricates a run)", () => {
    expect(classifyStripeKey(undefined)).toBe("missing");
    expect(classifyStripeKey("")).toBe("missing");
    expect(classifyStripeKey("   ")).toBe("missing");
    expect(classifyStripeKey("sk_test_...")).toBe("missing"); // the .env.example placeholder
  });

  test("a live key → 'live' (refused — no real charges in a verifier)", () => {
    expect(classifyStripeKey("sk_live_realkey123")).toBe("live");
  });

  test("a test key → 'test' (the only mode that runs the live send)", () => {
    expect(classifyStripeKey("sk_test_realkey123")).toBe("test");
  });
});
