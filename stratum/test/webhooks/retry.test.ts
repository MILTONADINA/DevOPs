// Unit tests for the in-memory webhook backoff retrier (injected scheduler → deterministic).

import { describe, test, expect } from "vitest";
import { createWebhookRetrier, RETRY_DELAYS_MS } from "../../src/webhooks/retry";
import type { DeliveryResult } from "../../src/webhooks/deliver";

function harness(deliverResults: boolean[]) {
  const calls: string[] = [];
  const scheduled: { fn: () => Promise<void>; delay: number }[] = [];
  let idx = 0;
  const deliver = (url: string): Promise<DeliveryResult> => {
    calls.push(url);
    const ok = deliverResults[idx] ?? false;
    idx++;
    return Promise.resolve({ delivered: ok, status: ok ? 200 : 500 });
  };
  let undelivered: { url: string; attempts: number } | null = null;
  const retrier = createWebhookRetrier({
    deliver,
    schedule: (fn, delay) => {
      scheduled.push({ fn, delay });
    },
    onUndelivered: (i) => {
      undelivered = i;
    },
  });
  return { retrier, calls, scheduled, getUndelivered: () => undelivered };
}

describe("createWebhookRetrier", () => {
  test("all attempts fail → backoff 5s/30s/5min/30min/2hr, then undelivered (1 initial + 5 retries)", async () => {
    const h = harness([false, false, false, false, false, false]);
    const first = await h.retrier.send("https://x", "{}", "s");
    expect(first.delivered).toBe(false);
    expect(h.calls).toHaveLength(1); // the initial attempt

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      expect(h.scheduled[i]!.delay).toBe(RETRY_DELAYS_MS[i]); // exact backoff schedule
      await h.scheduled[i]!.fn();
    }

    expect(h.calls).toHaveLength(6); // 1 initial + 5 retries
    expect(h.scheduled).toHaveLength(5);
    expect(h.getUndelivered()).toEqual({ url: "https://x", attempts: 6 });
  });

  test("a retry that succeeds stops the backoff (no further schedule, not undelivered)", async () => {
    const h = harness([false, false, true]); // initial fail, retry#1 fail, retry#2 OK
    await h.retrier.send("https://x", "{}", "s");
    await h.scheduled[0]!.fn();
    await h.scheduled[1]!.fn();
    expect(h.calls).toHaveLength(3);
    expect(h.scheduled).toHaveLength(2); // retry#2 succeeded → nothing further scheduled
    expect(h.getUndelivered()).toBeNull();
  });

  test("first attempt succeeds → no retries scheduled at all", async () => {
    const h = harness([true]);
    const r = await h.retrier.send("https://x", "{}", "s");
    expect(r.delivered).toBe(true);
    expect(h.scheduled).toHaveLength(0);
  });
});
