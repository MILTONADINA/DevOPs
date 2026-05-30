// Integration tests for the /v1/messages STREAMING branch via app.inject(),
// with an injected fake forwardStream (fixture SSE chunks) — no real network.
// Verifies: SSE passthrough to client, accumulated turn captured (minimal
// response shape: id/usage/stop_reason), Accept-header detection, upstream
// error passthrough, network-fail → 502, mid-stream error event.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");
const captureMod = await import("../../src/proxy/capture");
import type { MessagesDeps, StreamForwardResult } from "../../src/proxy/forward";

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

async function* gen(arr: string[]): AsyncGenerator<string> {
  for (const c of arr) yield c;
}

function makeStreamDeps(streamResult: StreamForwardResult | (() => Promise<never>)) {
  const fs = { writes: [] as { path: string; data: string }[], writeFileSync: (p: string, d: string) => void fs.writes.push({ path: p, data: d }) };
  const capture = captureMod.createCaptureStore({ sessionId: "strm", outputFile: "/tmp/strm.json", fs });
  const deps: MessagesDeps = {
    apiKey: "sk-test",
    forward: async () => ({ status: 200, data: {} }), // unused in streaming path
    forwardStream:
      typeof streamResult === "function"
        ? (streamResult as () => Promise<never>)
        : async () => streamResult,
    countTokens: async () => ({ input_tokens: 5, token_count_method: "exact", message_breakdown: [] }),
    capture,
  };
  return { deps, capture, fs };
}

const body = { model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true };

describe("POST /v1/messages — streaming happy path", () => {
  test("tees SSE to the client AND captures the accumulated turn", async () => {
    const { deps, capture } = makeStreamDeps({ status: 200, stream: gen(SSE_CHUNKS) });
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Client received the raw SSE passthrough (text deltas present).
    expect(res.payload).toContain("Hi");
    expect(res.payload).toContain(" there");
    expect(res.payload).toContain("message_stop");

    // Captured the accumulated turn (minimal response shape by design).
    const reqs = capture.getSession().requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.response.id).toBe("msg_s");
    expect(reqs[0]!.response.stop_reason).toBe("end_turn");
    expect(reqs[0]!.response.usage?.output_tokens).toBe(4); // from message_delta
  });

  test("detected via Accept: text/event-stream header (no body.stream)", async () => {
    const { deps, capture } = makeStreamDeps({ status: 200, stream: gen(SSE_CHUNKS) });
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { accept: "text/event-stream" },
      payload: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(capture.getSession().requests).toHaveLength(1);
  });
});

describe("POST /v1/messages — streaming usage recording (commercial)", () => {
  const resolve = (raw: string) => Promise.resolve(raw === "k" ? { orgId: "o1", keyId: "i" } : null);
  type Rec = { orgId: string; model: string; inputTokens: number; outputTokens: number };

  test("bills the upstream message_start input_tokens + message_delta output_tokens (not the pre-flight estimate)", async () => {
    const { deps } = makeStreamDeps({ status: 200, stream: gen(SSE_CHUNKS) });
    // Pre-flight estimate is deliberately wrong (77); the upstream stream carries input_tokens=5 / output=4.
    deps.countTokens = async () => ({ input_tokens: 77, token_count_method: "estimated", message_breakdown: [] });
    const recorded: Rec[] = [];
    deps.recordUsage = async (e) => void recorded.push(e as Rec);
    app = buildProxy({ cors: false, rateLimit: false, messages: deps, auth: { resolve } });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer k" }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ orgId: "o1", inputTokens: 5, outputTokens: 4 }); // upstream-confirmed, not 77
  });

  test("recovers output_tokens via flush-in-finally when the stream errors with message_delta still buffered", async () => {
    // message_start (complete), then a message_delta WITHOUT its trailing blank line (so it sits in the
    // parser buffer), then the upstream throws. The old code's flush() lived in the try block and was
    // skipped on a throw → output_tokens lost (0). flush() now runs in finally → the buffered delta (4) is recovered.
    async function* deltaBufferedThenThrow(): AsyncGenerator<string> {
      yield SSE_CHUNKS[0]!; // message_start (input_tokens=5), complete with \n\n
      yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}'; // NO trailing \n\n
      throw new Error("dropped after delta buffered");
    }
    const { deps } = makeStreamDeps({ status: 200, stream: deltaBufferedThenThrow() });
    const recorded: Rec[] = [];
    deps.recordUsage = async (e) => void recorded.push(e as Rec);
    app = buildProxy({ cors: false, rateLimit: false, messages: deps, auth: { resolve } });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer k" }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("upstream_stream_error"); // client still saw the error event
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ inputTokens: 5, outputTokens: 4 }); // delta recovered from the buffer
  });
});

describe("POST /v1/messages — streaming error handling", () => {
  test("upstream non-200 is passed through (not streamed, not captured)", async () => {
    const { deps, capture } = makeStreamDeps({ status: 429, data: { type: "error", error: { type: "rate_limit_error" } } });
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: body });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe("rate_limit_error");
    expect(capture.getSession().requests).toHaveLength(0);
  });

  test("forwardStream throws (network) → 502", async () => {
    const { deps } = makeStreamDeps(async () => {
      throw new Error("ECONNREFUSED");
    });
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: body });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe("upstream_unreachable");
  });

  test("mid-stream throw emits an SSE error event + captures partial", async () => {
    async function* boom(): AsyncGenerator<string> {
      yield SSE_CHUNKS[0]!; // message_start
      yield SSE_CHUNKS[2]!; // a text delta
      throw new Error("stream dropped");
    }
    const { deps, capture } = makeStreamDeps({ status: 200, stream: boom() });
    app = buildProxy({ cors: false, rateLimit: false, messages: deps });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: body });
    expect(res.statusCode).toBe(200); // headers already sent as SSE
    expect(res.payload).toContain("upstream_stream_error");
    // Partial turn still captured (what was forwarded).
    expect(capture.getSession().requests).toHaveLength(1);
    expect(capture.getSession().requests[0]!.response.id).toBe("msg_s");
  });
});
