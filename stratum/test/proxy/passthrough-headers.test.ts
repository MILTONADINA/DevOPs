// Transparent-proxy header passthrough: a partner's Anthropic SDK sends anthropic-version and (for
// beta features) anthropic-beta. The proxy must forward them upstream rather than hardcode the version
// + drop beta. Tests the upstream-header build (forwardToAnthropic, via the axios mock) AND the route's
// extraction of those headers from the inbound request.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { forwardToAnthropic } from "../../src/proxy/forward";
import { captureState, setAxiosResponse, resetMockState } from "../helpers/capture-harness";
import type { ForwardHeaders, MessagesDeps } from "../../src/proxy/forward";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
const { buildProxy } = await import("../../src/proxy/app");
const captureMod = await import("../../src/proxy/capture");

const BODY = { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 8 } as never;

describe("forwardToAnthropic — upstream header passthrough", () => {
  beforeEach(() => resetMockState());

  test("forwards the client's anthropic-version + anthropic-beta", async () => {
    setAxiosResponse({ ok: true });
    await forwardToAnthropic(BODY, "sk-ant-x", "https://api.anthropic.com", { anthropicVersion: "2099-01-01", anthropicBeta: "feat-a,feat-b" });
    const headers = (captureState.axios.postCalls[0]!.config as { headers: Record<string, string> }).headers;
    expect(headers["anthropic-version"]).toBe("2099-01-01");
    expect(headers["anthropic-beta"]).toBe("feat-a,feat-b");
    expect(headers["x-api-key"]).toBe("sk-ant-x");
  });

  test("defaults the version + omits anthropic-beta when the client sent none", async () => {
    setAxiosResponse({ ok: true });
    await forwardToAnthropic(BODY, "sk-ant-x", "https://api.anthropic.com");
    const headers = (captureState.axios.postCalls[0]!.config as { headers: Record<string, string> }).headers;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("/v1/messages — extracts the client's version + beta headers", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) { await app.close(); app = undefined; } });

  function depsCapturing(sink: { p?: ForwardHeaders }): MessagesDeps {
    return {
      apiKey: "sk-ant-test",
      forward: async (_b, _k, p) => { sink.p = p; return { status: 200, data: { ok: true } }; },
      forwardStream: async () => ({ status: 200, stream: undefined } as never),
      countTokens: async () => ({ input_tokens: 1, token_count_method: "exact", message_breakdown: [] }),
      capture: captureMod.createCaptureStore({ sessionId: "s", outputFile: "/tmp/s.json", fs: { writeFileSync: () => undefined } as never }),
    };
  }

  test("anthropic-version + anthropic-beta on the request reach the forward", async () => {
    const sink: { p?: ForwardHeaders } = {};
    app = buildProxy({ cors: false, rateLimit: false, messages: depsCapturing(sink) });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "anthropic-version": "2030-02-02", "anthropic-beta": "prompt-caching-2024" }, payload: JSON.stringify(BODY) });
    expect(res.statusCode).toBe(200);
    expect(sink.p).toEqual({ anthropicVersion: "2030-02-02", anthropicBeta: "prompt-caching-2024" });
  });

  test("no version/beta headers → an empty passthrough (proxy defaults upstream)", async () => {
    const sink: { p?: ForwardHeaders } = {};
    app = buildProxy({ cors: false, rateLimit: false, messages: depsCapturing(sink) });
    await app.ready();
    await app.inject({ method: "POST", url: "/v1/messages", headers: { "content-type": "application/json" }, payload: JSON.stringify(BODY) });
    expect(sink.p).toEqual({});
  });
});
