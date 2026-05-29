// Unit tests for the pure helpers in forward.ts + stream-forward.ts
// (resolveAnthropicBaseUrl, isStreamingRequest). The files themselves are
// excluded from the coverage gate (live-HTTP wiring), but these helpers are
// pure + worth regression protection.

import { describe, test, expect } from "vitest";
import { resolveAnthropicBaseUrl } from "../../src/proxy/forward";
import { isStreamingRequest } from "../../src/proxy/stream-forward";
import type { MessagesBody } from "../../src/proxy/forward";

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
