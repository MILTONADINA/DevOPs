// Unit tests for the pure helpers in forward.ts + stream-forward.ts
// (resolveAnthropicBaseUrl, isStreamingRequest). The files themselves are
// excluded from the coverage gate (live-HTTP wiring), but these helpers are
// pure + worth regression protection.

import { describe, test, expect, vi } from "vitest";
import axios from "axios";
import { resolveAnthropicBaseUrl, upstreamTimeoutMs, upstreamIdleMs, forwardToAnthropic } from "../../src/proxy/forward";
import { isStreamingRequest, forwardStreamToAnthropic } from "../../src/proxy/stream-forward";
import type { MessagesBody } from "../../src/proxy/forward";

vi.mock("axios");

const body = (over: Record<string, unknown> = {}): MessagesBody =>
  ({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 8, ...over }) as MessagesBody;

describe("resolveAnthropicBaseUrl", () => {
  test("default when ANTHROPIC_BASE_URL unset", () => {
    const saved = process.env["ANTHROPIC_BASE_URL"];
    delete process.env["ANTHROPIC_BASE_URL"];
    try {
      expect(resolveAnthropicBaseUrl()).toBe("https://api.anthropic.com");
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_BASE_URL"] = saved;
    }
  });
  test("accepts http + https", () => {
    expect(resolveAnthropicBaseUrl("http://localhost:4090")).toBe("http://localhost:4090");
    expect(resolveAnthropicBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
  });
  test("strips trailing slashes", () => {
    expect(resolveAnthropicBaseUrl("http://localhost:4090//")).toBe("http://localhost:4090");
  });
  test("rejects non-http(s) protocol", () => {
    expect(() => resolveAnthropicBaseUrl("ftp://x")).toThrow(/http/);
    expect(() => resolveAnthropicBaseUrl("file:///etc/passwd")).toThrow(/http/);
  });
  test("rejects unparseable URL", () => {
    expect(() => resolveAnthropicBaseUrl("not a url")).toThrow(/parseable/);
  });
});

describe("isStreamingRequest", () => {
  test("true when body.stream === true", () => {
    expect(isStreamingRequest(body({ stream: true }), undefined)).toBe(true);
  });
  test("true when Accept includes text/event-stream", () => {
    expect(isStreamingRequest(body(), "text/event-stream")).toBe(true);
    expect(isStreamingRequest(body(), "application/json, text/event-stream")).toBe(true);
  });
  test("false when neither", () => {
    expect(isStreamingRequest(body(), undefined)).toBe(false);
    expect(isStreamingRequest(body({ stream: false }), "application/json")).toBe(false);
  });
});

describe("upstream timeouts (PB-49: a hung upstream can't pin a worker)", () => {
  test("upstreamTimeoutMs — default 120s, env override, ignores garbage/non-positive", () => {
    const saved = process.env["CQ_UPSTREAM_TIMEOUT_MS"];
    try {
      delete process.env["CQ_UPSTREAM_TIMEOUT_MS"];
      expect(upstreamTimeoutMs()).toBe(120_000);
      process.env["CQ_UPSTREAM_TIMEOUT_MS"] = "5000";
      expect(upstreamTimeoutMs()).toBe(5000);
      process.env["CQ_UPSTREAM_TIMEOUT_MS"] = "nope";
      expect(upstreamTimeoutMs()).toBe(120_000);
      process.env["CQ_UPSTREAM_TIMEOUT_MS"] = "0";
      expect(upstreamTimeoutMs()).toBe(120_000);
    } finally {
      if (saved === undefined) delete process.env["CQ_UPSTREAM_TIMEOUT_MS"];
      else process.env["CQ_UPSTREAM_TIMEOUT_MS"] = saved;
    }
  });

  test("upstreamIdleMs — default 60s + env override", () => {
    const saved = process.env["CQ_UPSTREAM_IDLE_MS"];
    try {
      delete process.env["CQ_UPSTREAM_IDLE_MS"];
      expect(upstreamIdleMs()).toBe(60_000);
      process.env["CQ_UPSTREAM_IDLE_MS"] = "10000";
      expect(upstreamIdleMs()).toBe(10_000);
    } finally {
      if (saved === undefined) delete process.env["CQ_UPSTREAM_IDLE_MS"];
      else process.env["CQ_UPSTREAM_IDLE_MS"] = saved;
    }
  });

  test("forwardToAnthropic passes a total timeout to axios (non-streaming bound)", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: { ok: true }, headers: {} });
    await forwardToAnthropic(body(), "k", "http://x");
    expect(axios.post).toHaveBeenCalledWith("http://x/v1/messages", expect.anything(), expect.objectContaining({ timeout: expect.any(Number) }));
  });

  test("forwardStreamToAnthropic passes an AbortSignal to axios (idle guard), no total timeout", async () => {
    async function* empty(): AsyncGenerator<string> {
      // immediately-ending stream
    }
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: empty(), headers: {} });
    const r = await forwardStreamToAnthropic(body({ stream: true }), "k", "http://x");
    const opts = vi.mocked(axios.post).mock.lastCall![2] as Record<string, unknown>;
    expect(opts["signal"]).toBeDefined(); // idle AbortController wired
    expect(opts["timeout"]).toBeUndefined(); // NOT a total cap on a long stream
    if (r.stream) {
      for await (const _ of r.stream) void _; // drain → clears the idle timer
    }
  });
});
