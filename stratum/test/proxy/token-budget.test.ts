// Unit tests for the per-org token-budget limiter (in-memory windows, injected clock).

import { describe, test, expect } from "vitest";
import { createTokenBudget } from "../../src/proxy/token-budget";

// starter: 50,000 tokens/min · 1,000,000 tokens/day.

describe("createTokenBudget — minute window", () => {
  test("allows up to the minute budget; rejects the overflow WITHOUT consuming it; resets next minute", async () => {
    let t = 1_000_000;
    const budget = createTokenBudget({ getPlan: () => Promise.resolve("starter"), now: () => t });

    expect((await budget.tryConsume("o", 40_000)).allowed).toBe(true); // 40k ≤ 50k
    const over = await budget.tryConsume("o", 20_000); // 40k + 20k = 60k > 50k
    expect(over).toMatchObject({ allowed: false, limitType: "tokens_per_minute", limit: 50_000, used: 40_000 });
    // the rejected attempt did NOT consume → a smaller one still fits (40k + 5k = 45k)
    expect((await budget.tryConsume("o", 5_000)).allowed).toBe(true);

    t += 60_001; // next minute → window resets
    expect((await budget.tryConsume("o", 50_000)).allowed).toBe(true);
  });

  test("per-org isolation — one org's spend doesn't affect another", async () => {
    const budget = createTokenBudget({ getPlan: () => Promise.resolve("starter"), now: () => 5_000 });
    expect((await budget.tryConsume("a", 50_000)).allowed).toBe(true);
    expect((await budget.tryConsume("a", 1)).allowed).toBe(false); // a is maxed
    expect((await budget.tryConsume("b", 50_000)).allowed).toBe(true); // b is fresh
  });
});

describe("createTokenBudget — day window", () => {
  test("rejects once the daily budget is hit (across many minutes)", async () => {
    let t = 2_000_000;
    const budget = createTokenBudget({ getPlan: () => Promise.resolve("starter"), now: () => t });
    for (let i = 0; i < 20; i++) {
      expect((await budget.tryConsume("o", 50_000)).allowed).toBe(true); // 20 × 50k = 1,000,000 (the daily cap)
      t += 60_001; // advance a minute (resets the minute window, not the day)
    }
    const dayOver = await budget.tryConsume("o", 50_000);
    expect(dayOver).toMatchObject({ allowed: false, limitType: "tokens_per_day", limit: 1_000_000 });
  });

  test("enterprise has unlimited daily tokens (Infinity)", async () => {
    let t = 0;
    const budget = createTokenBudget({ getPlan: () => Promise.resolve("enterprise"), now: () => t });
    for (let i = 0; i < 30; i++) {
      expect((await budget.tryConsume("o", 1_000_000)).allowed).toBe(true); // 1M/min cap, unlimited/day
      t += 60_001;
    }
  });
});

describe("createTokenBudget — plan resolution", () => {
  test("an unknown plan falls back to starter limits", async () => {
    const budget = createTokenBudget({ getPlan: () => Promise.resolve("mystery"), now: () => 1 });
    expect((await budget.tryConsume("o", 60_000)).allowed).toBe(false); // > starter's 50k/min
  });
  test("the plan is cached (not re-resolved every request within a minute)", async () => {
    let calls = 0;
    const budget = createTokenBudget({
      getPlan: () => {
        calls++;
        return Promise.resolve("growth");
      },
      now: () => 1_000,
    });
    await budget.tryConsume("o", 1);
    await budget.tryConsume("o", 1);
    await budget.tryConsume("o", 1);
    expect(calls).toBe(1); // resolved once, then cached
  });
});
