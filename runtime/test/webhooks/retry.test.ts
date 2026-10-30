// Unit tests for the in-memory webhook backoff retrier (injected scheduler → deterministic).

import { describe, test, expect } from "vitest";
import { createWebhookRetrier, RETRY_DELAYS_MS, type UndeliveredInfo } from "../../src/webhooks/retry";
import type { DeliveryResult } from "../../src/webhooks/deliver";

const EVT = "evt_123e4567-e89b-12d3-a456-426614174000";

function harness(deliverResults: Array<boolean | Partial<DeliveryResult>>, extra: { maxTotalMs?: number; clock?: { t: number } } = {}) {
  const calls: string[] = [];
  const scheduled: { fn: () => Promise<void>; delay: number }[] = [];
  let idx = 0;
  const deliver = (url: string): Promise<DeliveryResult> => {
    calls.push(url);
    const o = deliverResults[idx] ?? false;
    idx++;
    if (typeof o === "object") return Promise.resolve({ delivered: false, retryable: true, reasonClass: "http_5xx", status: 500, ...o });
    return Promise.resolve(o ? { delivered: true, status: 200, retryable: false } : { delivered: false, status: 500, retryable: true, reasonClass: "http_5xx" });
  };
  let undelivered: UndeliveredInfo | null = null;
  const retrier = createWebhookRetrier({
    deliver,
    random: () => 0.5,
    now: () => extra.clock?.t ?? 0,
    ...(extra.maxTotalMs !== undefined ? { maxTotalMs: extra.maxTotalMs } : {}),
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
    const first = await h.retrier.send("https://x", "{}", "s", EVT);
    expect(first.delivered).toBe(false);
    expect(h.calls).toHaveLength(1); // the initial attempt

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      expect(h.scheduled[i]!.delay).toBe(RETRY_DELAYS_MS[i]); // exact backoff schedule
      await h.scheduled[i]!.fn();
    }

    expect(h.calls).toHaveLength(6); // 1 initial + 5 retries
    expect(h.scheduled).toHaveLength(5);
    expect(h.getUndelivered()).toMatchObject({ url: "https://x", eventId: EVT, attempts: 6, lastStatus: 500, reasonClass: "http_5xx" });
  });

  test("a retry that succeeds stops the backoff (no further schedule, not undelivered)", async () => {
    const h = harness([false, false, true]); // initial fail, retry#1 fail, retry#2 OK
    await h.retrier.send("https://x", "{}", "s", EVT);
    await h.scheduled[0]!.fn();
    await h.scheduled[1]!.fn();
    expect(h.calls).toHaveLength(3);
    expect(h.scheduled).toHaveLength(2); // retry#2 succeeded → nothing further scheduled
    expect(h.getUndelivered()).toBeNull();
  });

  test("first attempt succeeds → no retries scheduled at all", async () => {
    const h = harness([true]);
    const r = await h.retrier.send("https://x", "{}", "s", EVT);
    expect(r.delivered).toBe(true);
    expect(h.scheduled).toHaveLength(0);
  });
});

describe("retry policy", () => {
  test("jitter: delay = base * (0.8 + 0.4 * random)", async () => {
    for (const [rnd, factor] of [[0, 0.8], [1, 1.2]] as const) {
      const scheduled: number[] = [];
      const r = createWebhookRetrier({ deliver: () => Promise.resolve({ delivered: false, retryable: true, reasonClass: "network" }), schedule: (_f, d) => void scheduled.push(d), random: () => rnd, now: () => 0 });
      await r.send("https://x", "{}", "s", EVT);
      expect(scheduled[0]).toBeCloseTo(RETRY_DELAYS_MS[0]! * factor, 5);
    }
  });
  test.each([
    ["400", { status: 400, retryable: false, reasonClass: "http_4xx" }],
    ["401", { status: 401, retryable: false, reasonClass: "http_4xx" }],
    ["403", { status: 403, retryable: false, reasonClass: "http_4xx" }],
    ["404", { status: 404, retryable: false, reasonClass: "http_4xx" }],
    ["410", { status: 410, retryable: false, reasonClass: "http_4xx" }],
    ["redirect", { status: 302, retryable: false, reasonClass: "redirect" }],
    ["ssrf", { retryable: false, reasonClass: "ssrf_blocked" }],
  ] as const)("%s is never retried and dead-letters after 1 attempt", async (_n, res) => {
    const h = harness([res as Partial<DeliveryResult>]);
    await h.retrier.send("https://x", "{}", "s", EVT);
    expect(h.scheduled).toHaveLength(0);
    expect(h.getUndelivered()).toMatchObject({ attempts: 1, eventId: EVT, reasonClass: res.reasonClass });
  });
  test.each([
    ["429", { status: 429, reasonClass: "http_429" }],
    ["503", { status: 503, reasonClass: "http_5xx" }],
    ["network", { reasonClass: "network" }],
    ["timeout", { reasonClass: "timeout" }],
  ] as const)("%s is scheduled", async (_n, res) => {
    const h = harness([res as Partial<DeliveryResult>]);
    await h.retrier.send("https://x", "{}", "s", EVT);
    expect(h.scheduled).toHaveLength(1);
  });
  test("a result without retryable === true is not retried (fail closed)", async () => {
    const retrier = createWebhookRetrier({ deliver: () => Promise.resolve({ delivered: false } as unknown as DeliveryResult), schedule: () => { throw new Error("must not schedule"); }, random: () => 0.5, now: () => 0 });
    await retrier.send("https://x", "{}", "s", EVT);
  });
  test("Retry-After replaces the delay, is clamped to the longest backoff, and bad values are ignored", async () => {
    const max = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    for (const [ra, expected] of [[42_000, 42_000], [999_999_999_000, max], [0, 0], [undefined, RETRY_DELAYS_MS[0]!], [-5, RETRY_DELAYS_MS[0]!], [Number.NaN, RETRY_DELAYS_MS[0]!]] as const) {
      const h = harness([{ status: 429, reasonClass: "http_429", ...(ra !== undefined ? { retryAfterMs: ra } : {}) }]);
      await h.retrier.send("https://x", "{}", "s", EVT);
      expect(h.scheduled[0]!.delay).toBe(expected);
    }
  });
  test("total-time cap stops early with budget_exhausted", async () => {
    const clock = { t: 0 };
    const h = harness([false, false, false], { maxTotalMs: 40_000, clock });
    await h.retrier.send("https://x", "{}", "s", EVT); // schedules 5s
    clock.t = 5_000;
    await h.scheduled[0]!.fn(); // next 30s -> 35s <= 40s, scheduled
    expect(h.scheduled).toHaveLength(2);
    clock.t = 35_000;
    await h.scheduled[1]!.fn(); // next 300s would exceed the cap
    expect(h.scheduled).toHaveLength(2);
    expect(h.getUndelivered()).toMatchObject({ attempts: 3, reasonClass: "budget_exhausted", lastStatus: 500 });
  });
  test("cap is rechecked when the timer fires: a late timer gives up without another attempt", async () => {
    const clock = { t: 0 };
    const h = harness([false, true], { maxTotalMs: 40_000, clock });
    await h.retrier.send("https://x", "{}", "s", EVT); // schedules 5s
    clock.t = 100_000; // event loop was busy; timer fires far past the cap
    await h.scheduled[0]!.fn();
    expect(h.calls).toHaveLength(1);
    expect(h.getUndelivered()).toMatchObject({ attempts: 1, reasonClass: "budget_exhausted", lastStatus: 500 });
  });
  test.each(["../../x", "x", "evt_../../x", ""])("eventId %j is rejected before any delivery", async (bad) => {
    const h = harness([true]);
    await expect(h.retrier.send("https://x", "{}", "s", bad)).rejects.toThrow(/event id/);
    expect(h.calls).toHaveLength(0);
  });
});
