// Unit tests for src/proxy/token-count.ts — exact counting + hash cache +
// honest flagged fallback. Uses a fake Anthropic client (only messages.countTokens).

import { describe, test, expect, vi } from "vitest";
import { createTokenCounter } from "../../src/proxy/token-count";
import type { MessagesBody } from "../../src/proxy/forward";

function fakeClient(countTokens: (args: unknown) => Promise<{ input_tokens: number }>) {
  return { messages: { countTokens: vi.fn(countTokens) } } as never;
}

const bodyA: MessagesBody = { model: "claude-opus-4-7", messages: [{ role: "user", content: "alpha" }], max_tokens: 64 };
const bodyB: MessagesBody = { model: "claude-opus-4-7", messages: [{ role: "user", content: "beta beta" }], max_tokens: 64 };

describe("token counter — exact + cache", () => {
  test("exact path returns exact + flags method", async () => {
    const client = fakeClient(async () => ({ input_tokens: 42 }));
    const counter = createTokenCounter(client);
    const r = await counter.count(bodyA);
    expect(r.input_tokens).toBe(42);
    expect(r.token_count_method).toBe("exact");
  });

  test("identical payload is cached (client called once)", async () => {
    const fn = vi.fn(async () => ({ input_tokens: 10 }));
    const counter = createTokenCounter(fakeClient(fn));
    await counter.count(bodyA);
    await counter.count(bodyA);
    await counter.count(bodyA);
    expect(fn).toHaveBeenCalledTimes(1); // cached after first
  });

  test("different payloads are counted separately", async () => {
    const fn = vi.fn(async () => ({ input_tokens: 7 }));
    const counter = createTokenCounter(fakeClient(fn));
    await counter.count(bodyA);
    await counter.count(bodyB);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("token counter — honest fallback", () => {
  test("countTokens throw → estimated method + heuristic > 0 (never silently exact)", async () => {
    const counter = createTokenCounter(
      fakeClient(async () => {
        throw new Error("countTokens 500");
      }),
    );
    const r = await counter.count(bodyA);
    expect(r.token_count_method).toBe("estimated");
    expect(r.input_tokens).toBeGreaterThan(0);
  });

  test("estimates are NOT cached (a later call can resolve to exact)", async () => {
    let fail = true;
    const fn = vi.fn(async () => {
      if (fail) throw new Error("transient");
      return { input_tokens: 99 };
    });
    const counter = createTokenCounter(fakeClient(fn));

    const est = await counter.count(bodyA);
    expect(est.token_count_method).toBe("estimated");

    fail = false;
    const exact = await counter.count(bodyA);
    expect(exact.token_count_method).toBe("exact");
    expect(exact.input_tokens).toBe(99);
    expect(fn).toHaveBeenCalledTimes(2); // estimate wasn't cached, so re-counted
  });
});
