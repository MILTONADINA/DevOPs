import { afterEach, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BiEncoder } from "../../src/pruner/encoder";
import { createShadowObserver, type ShadowMetric } from "../../src/proxy/shadow-observer";
import { ConversationError } from "../../src/proxy/conversation";
import type { MessagesDeps } from "../../src/proxy/forward";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
const { buildProxy } = await import("../../src/proxy/app");
const { createCaptureStore } = await import("../../src/proxy/capture");

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const ID = "1037edab-1555-43cb-8784-754b357ea390";
const body = { model: "claude-sonnet-4-6", max_tokens: 20, messages: [{ role: "user", content: "hello" }] };
const auth = { resolve: async (key: string) => (key === "one" ? { orgId: "org", keyId: "key-one" } : key === "two" ? { orgId: "org", keyId: "key-two" } : null), protectedPrefixes: ["/v1/"] };

function deps(): MessagesDeps {
  const fs = { writeFileSync: () => undefined } as unknown as Parameters<typeof createCaptureStore>[0]["fs"];
  return {
    apiKey: "upstream",
    capture: createCaptureStore({ sessionId: "test", outputFile: "/tmp/test.json", fs }),
    countTokens: async () => ({ input_tokens: 5, token_count_method: "exact", message_breakdown: [] }),
    forward: async () => ({ status: 200, data: { content: [{ type: "text", text: "world" }], usage: { input_tokens: 5, output_tokens: 2 } } }),
    forwardStream: async () => ({
      status: 200,
      stream: (async function* () {
        yield 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":5}}}\n\n';
        yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n';
        yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      })(),
    }),
  };
}

describe("trusted commercial conversation route", () => {
  test("creates, echoes, and verifies identity before normal forwarding", async () => {
    const d = deps();
    const forward = vi.spyOn(d, "forward");
    d.resolveConversation = async (input) => {
      if (input.requestedId && input.keyId !== "key-one") throw new ConversationError("conversation not found", 404);
      return ID;
    };
    app = buildProxy({ cors: false, rateLimit: false, auth, messages: d });
    const first = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer one" }, payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cq-conversation-id"]).toBe(ID);
    const second = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer one", "x-cq-conversation-id": ID }, payload: body });
    expect(second.statusCode).toBe(200);
    const foreign = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer two", "x-cq-conversation-id": ID }, payload: body });
    expect(foreign.statusCode).toBe(404);
    expect(forward).toHaveBeenCalledTimes(2);
  });

  test("rejects malformed identity before any upstream call", async () => {
    const d = deps();
    const forward = vi.spyOn(d, "forward");
    d.resolveConversation = async (input) => {
      if (input.requestedId) throw new ConversationError("invalid conversation ID", 400);
      return ID;
    };
    app = buildProxy({ cors: false, rateLimit: false, auth, messages: d });
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer one", "x-cq-conversation-id": "client-chosen" }, payload: body });
    expect(response.statusCode).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  test("shadow failure leaves streaming response intact", async () => {
    const d = deps();
    d.resolveConversation = async () => ID;
    d.observeConversation = vi.fn(async () => {
      throw new Error("secret user text");
    });
    app = buildProxy({ cors: false, rateLimit: false, auth, messages: d });
    const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer one" }, payload: { ...body, stream: true } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-cq-conversation-id"]).toBe(ID);
    expect(response.body).toContain("event: message_stop");
    expect(d.observeConversation).toHaveBeenCalledOnce();
  });
});

describe("shadow observer", () => {
  const encoder: BiEncoder = { dimension: 2, encode: async (texts) => texts.map(() => Float32Array.from([1, 0])) };
  test("emits only counts for the same trusted conversation and isolates other keys", async () => {
    const metrics: ShadowMetric[] = [];
    const observe = createShadowObserver(encoder, (metric) => {
      metrics.push(metric);
    });
    const event = { conversationId: ID, orgId: "org", keyId: "one", query: "private query", assistant: "private answer" };
    await observe(event);
    await observe(event);
    expect(metrics[1]?.candidateCount).toBe(2);
    expect(JSON.stringify(metrics)).not.toContain("private");
    await expect(observe({ ...event, keyId: "two" })).rejects.toThrow("binding changed");
    await expect(observe({ ...event, projectScopeId: "org/orion" })).rejects.toThrow("binding changed");
  });

  test("evicts inactive conversations and caps live windows", async () => {
    let tick = 100_000_000;
    const metrics: ShadowMetric[] = [];
    const observe = createShadowObserver(
      encoder,
      (metric) => {
        metrics.push(metric);
      },
      { now: () => tick, maxConversations: 1, maxTurns: 2 },
    );
    const event = { conversationId: ID, orgId: "org", keyId: "one", query: "q", assistant: "a" };
    await observe(event);
    await observe({ ...event, conversationId: "2037edab-1555-43cb-8784-754b357ea390" });
    await observe(event);
    expect(metrics[2]?.candidateCount).toBe(0);
    tick += 7_200_001;
    await observe(event);
    expect(metrics[3]?.candidateCount).toBe(0);
  });

  test("counts only selected turns with unambiguous project-bound supersession", async () => {
    const metrics: ShadowMetric[] = [];
    const calls: unknown[][] = [];
    const observe = createShadowObserver(encoder, (metric) => metrics.push(metric), {
      supersession: {
        resolveEntities: async (org, session, project, exchanges) => {
          calls.push([org, session, project, exchanges]);
          return new Map([
            ["old-exchange", "oldFn"],
            ["new-exchange", "newFn"],
          ]);
        },
        findFunctionSuperseded: async (org, project, names) => {
          calls.push([org, project, names]);
          return [{ superseded: "oldFn", supersededBy: "newFn" }];
        },
      },
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", projectScopeId: "org/orion", query: "q", assistant: "a" };
    await observe({ ...event, exchangeId: "old-exchange" });
    await observe({ ...event, exchangeId: "new-exchange" });
    await observe({ ...event, exchangeId: "ambiguous-exchange" });
    expect(calls).toContainEqual(["org", ID, "orion", ["old-exchange", "new-exchange"]]);
    expect(metrics[2]?.supersededSelectedCount).toBe(2);
    expect(JSON.stringify(metrics)).not.toContain("oldFn");
    expect(JSON.stringify(metrics)).not.toContain("newFn");
  });
});
