// Unit tests for src/proxy/retry.ts — retry/backoff policy. Pure: injected
// sleep (records delays, no real timers) + deterministic rng (no jitter).

import { describe, test, expect, vi } from "vitest";
import { withRetry, withStreamRetry, parseRetryAfterMs, type ForwardFn, type StreamForwardFn } from "../../src/proxy/retry";
import type { ForwardResult, MessagesBody } from "../../src/proxy/forward";
import type { StreamForwardResult } from "../../src/proxy/stream-forward";

const body = { model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 8 } as MessagesBody;

function harness(forward: ForwardFn, overrides = {}) {
  const delays: number[] = [];
  const wrapped = withRetry(forward, {
    baseDelayMs: 100,
    maxRetries: 3,
    rng: () => 0, // deterministic: no jitter
    sleep: async (ms: number) => void delays.push(ms),
    ...overrides,
  });
  return { wrapped, delays };
}

function seq(...results: (ForwardResult | Error)[]): ForwardFn {
  let i = 0;
  return async () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r as ForwardResult;
  };
}

describe("withRetry — HTTP status policy", () => {
  test("429 then 200 → retries once, returns 200", async () => {
    const { wrapped, delays } = harness(seq({ status: 429, data: {} }, { status: 200, data: { ok: true } }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(1); // one backoff before the successful retry
  });

  test("429 honors Retry-After header (seconds → ms)", async () => {
    const { wrapped, delays } = harness(
      seq({ status: 429, data: {}, headers: { "retry-after": "2" } }, { status: 200, data: {} }),
    );
    await wrapped(body, "k");
    expect(delays[0]).toBe(2000);
  });

  test("persistent 5xx → exhausts maxRetries then returns the 5xx", async () => {
    const { wrapped, delays } = harness(seq({ status: 503, data: { e: 1 } }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(503);
    expect(delays).toHaveLength(3); // maxRetries backoffs (exponential 100,200,400)
    expect(delays).toEqual([100, 200, 400]);
  });

  test("2xx returns immediately (no retry)", async () => {
    const { wrapped, delays } = harness(seq({ status: 200, data: {} }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(0);
  });

  test("4xx (non-429) returns immediately (no retry)", async () => {
    const { wrapped, delays } = harness(seq({ status: 400, data: {} }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(400);
    expect(delays).toHaveLength(0);
  });
});

describe("withRetry — network errors", () => {
  test("network throw once then success → retries once", async () => {
    const { wrapped, delays } = harness(seq(new Error("ECONNRESET"), { status: 200, data: {} }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(1);
  });

  test("network throw twice → surfaces the error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { wrapped } = harness(fn);
    await expect(wrapped(body, "k")).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(2); // initial + one retry
  });
});

// The streaming path carries the majority of partner traffic; it must retry 429/5xx like the
// non-streaming path (the gap this fixes). withStreamRetry mirrors withRetry over StreamForwardResult.
async function* emptyStream(): AsyncGenerator<string> {
  // no chunks
}
function streamHarness(forward: StreamForwardFn, overrides = {}) {
  const delays: number[] = [];
  const wrapped = withStreamRetry(forward, { baseDelayMs: 100, maxRetries: 3, rng: () => 0, sleep: async (ms: number) => void delays.push(ms), ...overrides });
  return { wrapped, delays };
}
function streamSeq(...results: (StreamForwardResult | Error)[]): StreamForwardFn {
  let i = 0;
  return async () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r as StreamForwardResult;
  };
}

describe("withStreamRetry — streaming path gets the same 429/5xx policy", () => {
  test("429 then 2xx stream → retries once, returns the open stream", async () => {
    const { wrapped, delays } = streamHarness(streamSeq({ status: 429, data: { e: 1 } }, { status: 200, stream: emptyStream() }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(200);
    expect(res.stream).toBeDefined();
    expect(delays).toHaveLength(1);
  });

  test("429 honors Retry-After from the streaming error result's headers", async () => {
    const { wrapped, delays } = streamHarness(streamSeq({ status: 429, data: {}, headers: { "retry-after": "3" } }, { status: 200, stream: emptyStream() }));
    await wrapped(body, "k");
    expect(delays[0]).toBe(3000);
  });

  test("persistent 5xx → exhausts maxRetries then returns the 5xx (never an open stream)", async () => {
    const { wrapped, delays } = streamHarness(streamSeq({ status: 503, data: { e: 1 } }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(503);
    expect(res.stream).toBeUndefined();
    expect(delays).toEqual([100, 200, 400]);
  });

  test("2xx returns immediately (no retry, stream not re-driven)", async () => {
    const fn = vi.fn(async () => ({ status: 200, stream: emptyStream() }) as StreamForwardResult);
    const { wrapped, delays } = streamHarness(fn);
    await wrapped(body, "k");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  test("network throw once then success → one retry (before any byte)", async () => {
    const { wrapped, delays } = streamHarness(streamSeq(new Error("ECONNRESET"), { status: 200, stream: emptyStream() }));
    const res = await wrapped(body, "k");
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(1);
  });
});

describe("parseRetryAfterMs", () => {
  test("delta-seconds → ms", () => {
    expect(parseRetryAfterMs({ "retry-after": "5" })).toBe(5000);
  });
  test("absent / invalid → null", () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs({})).toBeNull();
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeNull();
  });
});
