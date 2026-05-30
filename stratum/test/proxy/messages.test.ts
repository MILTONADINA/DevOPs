// Integration tests for POST /v1/messages via app.inject(), with fully
// injected deps (fake forward / token-count / capture) so no real network,
// SDK, or disk is touched. Covers: happy-path forward+capture+return, exact
// vs estimated token method, upstream 4xx/5xx passthrough (not captured),
// network failure → 502, and request validation.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");
const captureMod = await import("../../src/proxy/capture");
import type { MessagesDeps, ForwardResult, TokenCountResult } from "../../src/proxy/forward";

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

function fakeFs() {
  const writes: { path: string; data: string }[] = [];
  return { writes, writeFileSync: (p: string, d: string) => void writes.push({ path: p, data: d }) };
}

function makeDeps(over: {
  forward?: MessagesDeps["forward"];
  countTokens?: MessagesDeps["countTokens"];
  fs?: { writes: { path: string; data: string }[]; writeFileSync: (p: string, d: string) => void };
} = {}) {
  const fs = over.fs ?? fakeFs();
  const capture = captureMod.createCaptureStore({
    sessionId: "test-session",
    outputFile: "/tmp/test-session.json",
    fs,
  });
  const forward: MessagesDeps["forward"] =
    over.forward ??
    (async (): Promise<ForwardResult> => ({
      status: 200,
      data: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 10, output_tokens: 3 },
        stop_reason: "end_turn",
      },
    }));
  const countTokens: MessagesDeps["countTokens"] =
    over.countTokens ??
    (async (): Promise<TokenCountResult> => ({
      input_tokens: 10,
      token_count_method: "exact",
      message_breakdown: [{ role: "user", token_count: 10 }],
    }));
  const deps: MessagesDeps = { forward, countTokens, capture, apiKey: "sk-test" };
  return { deps, fs, capture };
}

const goodBody = {
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 64,
};

describe("POST /v1/messages — happy path", () => {
  test("forwards, captures the turn, returns the upstream response verbatim", async () => {
    const { deps, fs, capture } = makeDeps();
    app = buildProxy({ cors: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: goodBody });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("msg_test");

    // Captured exactly one turn, flushed to the fake fs.
    expect(capture.getSession().requests).toHaveLength(1);
    expect(fs.writes.length).toBeGreaterThan(0);
    expect(capture.getSession().total_output_tokens).toBe(3);
  });

  test("estimated token method is carried through when countTokens fails", async () => {
    const { deps, capture } = makeDeps({
      countTokens: async () => {
        throw new Error("countTokens upstream 500");
      },
    });
    app = buildProxy({ cors: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: goodBody });
    expect(res.statusCode).toBe(200);
    expect(capture.getSession().requests[0]!.token_counts.token_count_method).toBe("estimated");
  });
});

describe("POST /v1/messages — error handling", () => {
  test("upstream 4xx is passed through and NOT captured", async () => {
    const { deps, capture } = makeDeps({
      forward: async () => ({ status: 429, data: { type: "error", error: { type: "rate_limit_error" } } }),
    });
    app = buildProxy({ cors: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: goodBody });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe("rate_limit_error");
    expect(capture.getSession().requests).toHaveLength(0); // error turns not captured
  });

  test("network failure (forward throws) → 502 upstream_unreachable", async () => {
    const { deps } = makeDeps({
      forward: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    app = buildProxy({ cors: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: goodBody });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe("upstream_unreachable");
  });

  test("missing messages[] → 400 invalid_request_error", async () => {
    const { deps } = makeDeps();
    app = buildProxy({ cors: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: { model: "m", max_tokens: 8 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });
});

describe("POST /v1/messages — token-budget gate (commercial)", () => {
  const resolve = (raw: string) => Promise.resolve(raw === "k" ? { orgId: "o1", keyId: "i" } : null);

  test("over the per-org token budget → 429, BEFORE forwarding upstream", async () => {
    let forwarded = false;
    const { deps } = makeDeps({
      forward: async () => {
        forwarded = true;
        return { status: 200, data: {} };
      },
    });
    deps.tokenBudget = { tryConsume: () => Promise.resolve({ allowed: false, limitType: "tokens_per_minute", limit: 50_000, used: 50_000 }) };
    app = buildProxy({ cors: false, messages: deps, auth: { resolve } });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer k" }, payload: goodBody });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.limit_type).toBe("tokens_per_minute");
    expect(forwarded).toBe(false); // never reached upstream
  });

  test("under budget → forwards normally", async () => {
    const { deps } = makeDeps();
    deps.tokenBudget = { tryConsume: () => Promise.resolve({ allowed: true, limit: 50_000, remaining: 49_990 }) };
    app = buildProxy({ cors: false, messages: deps, auth: { resolve } });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer k" }, payload: goodBody });
    expect(res.statusCode).toBe(200);
  });

  test("emits the X-RateLimit-*-Tokens headers (commercial — rateLimitByPlan on)", async () => {
    const { deps } = makeDeps();
    deps.tokenBudget = { tryConsume: () => Promise.resolve({ allowed: true, limit: 50_000, remaining: 49_990 }) };
    app = buildProxy({ cors: false, messages: deps, auth: { resolve }, rateLimitByPlan: { getPlan: () => Promise.resolve("starter") } });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer k" }, payload: goodBody });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit-tokens"]).toBe("50000");
    expect(res.headers["x-ratelimit-remaining-tokens"]).toBe("49990");
  });
});
