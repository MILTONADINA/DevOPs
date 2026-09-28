// Unit tests for the Cloudflare Worker request-handling core (pure). The CF runtime/deploy
// adapter (worker.ts) is NOT exercised here (no CF account) — only this verified logic is.

import { describe, test, expect } from "vitest";
import { routeWorkerRequest, healthBody, resolveBaseUrl, forwardMessages, type FetchLike } from "../../src/proxy/worker-core";

describe("routeWorkerRequest", () => {
  test("maps the Phase-1 surface; everything else is not_found", () => {
    expect(routeWorkerRequest("GET", "/health")).toEqual({ kind: "health" });
    expect(routeWorkerRequest("POST", "/v1/messages")).toEqual({ kind: "messages" });
    expect(routeWorkerRequest("GET", "/v1/messages")).toEqual({ kind: "not_found" }); // wrong method
    expect(routeWorkerRequest("POST", "/health")).toEqual({ kind: "not_found" }); // wrong method
    expect(routeWorkerRequest("GET", "/unknown")).toEqual({ kind: "not_found" });
  });
});

describe("healthBody", () => {
  test("identifies the edge-worker runtime", () => {
    expect(healthBody()).toEqual({ status: "ok", phase: "2+-edge-worker", runtime: "cloudflare-worker" });
  });
});

describe("resolveBaseUrl", () => {
  test("defaults to the Anthropic API; strips trailing slashes; honors a valid override", () => {
    expect(resolveBaseUrl(undefined)).toBe("https://api.anthropic.com");
    expect(resolveBaseUrl("")).toBe("https://api.anthropic.com");
    expect(resolveBaseUrl("http://localhost:4080/")).toBe("http://localhost:4080");
    expect(resolveBaseUrl("https://proxy.example.com")).toBe("https://proxy.example.com");
  });
  test("throws on an unparseable or non-http(s) URL", () => {
    expect(() => resolveBaseUrl("not a url")).toThrow(/invalid ANTHROPIC base URL/);
    expect(() => resolveBaseUrl("ftp://x")).toThrow(/must be http/);
  });
});

describe("forwardMessages", () => {
  test("forwards verbatim to <base>/v1/messages with the Anthropic headers; returns status + body", async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fakeFetch: FetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status: 200, text: () => Promise.resolve("upstream-body") });
    };
    const body = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], max_tokens: 10 };
    const res = await forwardMessages(body, "sk-key", fakeFetch, "https://api.anthropic.com");

    expect(res).toEqual({ status: 200, body: "upstream-body" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers["x-api-key"]).toBe("sk-key");
    expect(calls[0]!.init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(calls[0]!.init.body)).toEqual(body); // forwarded UNCHANGED
  });

  test("passes an upstream error status through (does not throw on 4xx/5xx)", async () => {
    const fakeFetch: FetchLike = () => Promise.resolve({ status: 429, text: () => Promise.resolve('{"error":"rate"}') });
    const res = await forwardMessages({}, "k", fakeFetch, "https://api.anthropic.com");
    expect(res).toEqual({ status: 429, body: '{"error":"rate"}' });
  });
});
