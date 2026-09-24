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

  test("two responses finish while shadow coverage waits for the first memory write", async () => {
    const d = deps();
    const metrics: ShadowMetric[] = [];
    const persisted = new Set<string>();
    let release!: () => void;
    let writes = 0;
    d.resolveConversation = async () => ID;
    d.recordMemory = async (event) => {
      writes++;
      if (writes === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      persisted.add(event.exchangeId!);
    };
    d.observeConversation = createShadowObserver({ dimension: 2, encode: async (texts) => texts.map(() => Float32Array.from([1, 0])) }, (metric) => metrics.push(metric), {
      factCoverage: async (_org, _session, _project, ids) => new Map(ids.filter((id) => persisted.has(id)).map((id) => [id, 1])),
    });
    app = buildProxy({ cors: false, rateLimit: false, auth, messages: d });
    const headers = { authorization: "Bearer one" };
    const first = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/messages", headers, payload: body });
    try {
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(metrics).toHaveLength(0);
    } finally {
      release();
    }
    await app.close();
    app = undefined;
    expect(metrics).toHaveLength(2);
    expect(metrics[0]?.candidateCount).toBe(0);
    expect(metrics[1]?.candidateCount).toBe(2);
    expect(metrics[1]?.factCoverage?.activeExchangeCount).toBe(1);
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
        findFreshSuperseded: async () => [],
      },
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", projectScopeId: "org/orion", query: "q", assistant: "a" };
    await observe({ ...event, exchangeId: "old-exchange" });
    await observe({ ...event, exchangeId: "new-exchange" });
    await observe({ ...event, exchangeId: "ambiguous-exchange" });
    expect(calls).toContainEqual(["org", ID, "orion", ["old-exchange", "new-exchange"]]);
    expect(metrics[2]?.candidateSupersededExchangeCount).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain("oldFn");
    expect(JSON.stringify(metrics)).not.toContain("newFn");
  });

  test("counts a fresh rename before graph promotion without treating both turns as deletable", async () => {
    const metrics: ShadowMetric[] = [];
    const observe = createShadowObserver(encoder, (metric) => metrics.push(metric), {
      now: () => 100_000_000,
      supersession: {
        resolveEntities: async () =>
          new Map([
            ["old-exchange", "oldFn"],
            ["new-exchange", "newFn"],
          ]),
        findFunctionSuperseded: async () => [],
        findFreshSuperseded: async (_org, _session, _project, exchanges) => {
          if (exchanges.includes("new-exchange")) {
            expect(exchanges).toEqual(["old-exchange", "new-exchange"]);
            return [{ superseded: "oldFn", supersededBy: "newFn" }];
          }
          return [];
        },
      },
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", query: "q", assistant: "a" };
    await observe({ ...event, exchangeId: "old-exchange" });
    await observe({ ...event, exchangeId: "new-exchange" });
    await observe({ ...event, exchangeId: "third-exchange" });
    expect(metrics[2]?.selectedCount).toBe(4);
    expect(metrics[2]?.candidateSupersededExchangeCount).toBe(1);
  });

  test("does not request fresh relations from selected mixed-fact exchanges", async () => {
    const resolvedCalls: string[][] = [];
    const freshCalls: string[][] = [];
    const observe = createShadowObserver(encoder, () => undefined, {
      now: () => 100_000_000,
      supersession: {
        resolveEntities: async (_org, _session, _project, exchanges) => {
          resolvedCalls.push(exchanges);
          return new Map([
            ["old", "oldFn"],
            ["new", "newFn"],
          ]);
        },
        findFunctionSuperseded: async () => [],
        findFreshSuperseded: async (_org, _session, _project, exchanges) => {
          freshCalls.push(exchanges);
          return [];
        },
      },
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", query: "q", assistant: "a" };
    for (const exchangeId of ["old", "new", "mixed", "current"]) await observe({ ...event, exchangeId });
    expect(resolvedCalls.at(-1)).toEqual(["old", "new", "mixed"]);
    expect(freshCalls.at(-1)).toEqual(["old", "new"]);
  });

  test("counts fact-bearing exchanges dropped by shadow selection once per exchange", async () => {
    const metrics: ShadowMetric[] = [];
    const calls: string[][] = [];
    const factEncoder: BiEncoder = {
      dimension: 2,
      encode: async (texts) => texts.map((value) => (value === "old" ? Float32Array.from([0, 1]) : Float32Array.from([1, 0]))),
    };
    const observe = createShadowObserver(factEncoder, (metric) => metrics.push(metric), {
      now: () => 100_000_000,
      factCoverage: async (_org, _session, _project, exchanges) => {
        calls.push(exchanges);
        return new Map([
          ["old-exchange", 2],
          ["new-exchange", 1],
        ]);
      },
      queryFactCandidates: async () =>
        new Map([
          ["old-exchange", 2],
          ["new-exchange", 1],
        ]),
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", projectScopeId: "org/orion" };
    await observe({ ...event, exchangeId: "old-exchange", query: "old", assistant: "old" });
    await observe({ ...event, exchangeId: "new-exchange", query: "new", assistant: "new" });
    await observe({ ...event, exchangeId: "current", query: "target", assistant: "pending" });
    expect(calls.at(-1)).toEqual(["old-exchange", "new-exchange"]);
    expect(metrics.at(-1)?.factCoverage).toEqual({
      activeExchangeCount: 2,
      selectedExchangeCount: 1,
      droppedExchangeCount: 1,
      activeFactCount: 3,
      selectedFactCount: 1,
      droppedFactCount: 2,
    });
    expect(metrics.at(-1)?.queryFactRescue).toEqual({
      matchedFactCount: 3,
      rescuedExchangeCount: 1,
      rescuedFactCount: 2,
      addedTurnCount: 2,
      candidateSelectedCount: 4,
    });
    expect(JSON.stringify(metrics.at(-1))).not.toContain("old-exchange");
    expect(JSON.stringify(metrics.at(-1))).not.toContain("target");
  });

  test("counts a partial fact-bearing exchange as dropped and proposes its missing turn", async () => {
    const metrics: ShadowMetric[] = [];
    const partialEncoder: BiEncoder = {
      dimension: 2,
      encode: async (texts) => texts.map((text) => (text === "low" ? Float32Array.from([0, 1]) : Float32Array.from([1, 0]))),
    };
    const observe = createShadowObserver(partialEncoder, (metric) => metrics.push(metric), {
      now: () => 100_000_000,
      factCoverage: async () => new Map([["partial", 2]]),
      queryFactCandidates: async () => new Map([["partial", 2]]),
    });
    const event = { conversationId: ID, orgId: "org", keyId: "key", projectScopeId: "org/orion" };
    await observe({ ...event, exchangeId: "partial", query: "high", assistant: "low" });
    await observe({ ...event, exchangeId: "current", query: "target", assistant: "pending" });
    expect(metrics.at(-1)?.selectedCount).toBe(1);
    expect(metrics.at(-1)?.factCoverage).toEqual({
      activeExchangeCount: 1,
      selectedExchangeCount: 0,
      droppedExchangeCount: 1,
      activeFactCount: 2,
      selectedFactCount: 0,
      droppedFactCount: 2,
    });
    expect(metrics.at(-1)?.queryFactRescue).toEqual({
      matchedFactCount: 2,
      rescuedExchangeCount: 1,
      rescuedFactCount: 2,
      addedTurnCount: 1,
      candidateSelectedCount: 2,
    });
  });

  test("marks coverage unavailable while a failed memory exchange remains hot", async () => {
    const metrics: ShadowMetric[] = [];
    const observe = createShadowObserver(encoder, (metric) => metrics.push(metric), {
      factCoverage: async () => new Map(),
      queryFactCandidates: async () => new Map([["failed", 1]]),
    });
    const event = { conversationId: ID, orgId: "org", keyId: "one", query: "private query", assistant: "private answer" };
    await observe({ ...event, exchangeId: "failed", memoryReady: Promise.resolve(false) });
    await observe({ ...event, exchangeId: "next", memoryReady: Promise.resolve(true) });
    expect(metrics[1]?.candidateCount).toBe(2);
    expect(metrics[1]?.provenanceIncompleteExchangeCount).toBe(1);
    expect(metrics[1]?.factCoverage).toBeUndefined();
    expect(metrics[1]?.queryFactRescue).toBeUndefined();
    expect(JSON.stringify(metrics)).not.toContain("private");
  });

  test("restores coverage after a failed exchange leaves the bounded hot window", async () => {
    const metrics: ShadowMetric[] = [];
    const observe = createShadowObserver(encoder, (metric) => metrics.push(metric), {
      maxTurns: 2,
      factCoverage: async () => new Map(),
    });
    const event = { conversationId: ID, orgId: "org", keyId: "one", query: "query", assistant: "answer" };
    await observe({ ...event, exchangeId: "failed", memoryReady: Promise.resolve(false) });
    await observe({ ...event, exchangeId: "next", memoryReady: Promise.resolve(true) });
    await observe({ ...event, exchangeId: "later", memoryReady: Promise.resolve(true) });
    expect(metrics[1]?.provenanceIncompleteExchangeCount).toBe(1);
    expect(metrics[2]?.provenanceIncompleteExchangeCount).toBeUndefined();
    expect(metrics[2]?.factCoverage).toEqual({
      activeExchangeCount: 0,
      selectedExchangeCount: 0,
      droppedExchangeCount: 0,
      activeFactCount: 0,
      selectedFactCount: 0,
      droppedFactCount: 0,
    });
  });
});
