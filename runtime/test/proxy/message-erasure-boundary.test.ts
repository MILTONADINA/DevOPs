// REQ-9/13, AC-B11: reject an explicit-session identity before protected message
// work, including the token counter's upstream request and content-keyed cache.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createSupabaseConversationResolver } from "../../src/proxy/conversation";
import type { MessagesDeps } from "../../src/proxy/forward";
import { makeFakeSupabase } from "../memory/fake-supabase";

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
const body = { model: "claude-sonnet-4-6", max_tokens: 20, messages: [{ role: "user", content: "synthetic request" }] };
const modes = ["normal", "stream body", "stream accept"] as const;
type Mode = (typeof modes)[number];

function harness(kind = "conversation", lookupFails = false, orgId = "org") {
  const db = makeFakeSupabase(
    { sessions: [{ id: ID, org_id: orgId, conversation_key_id: kind === "conversation" ? "key" : null, kind, ended_at: null, project_scope: null }] },
    lookupFails ? { selectError: new Set(["sessions"]) } : {},
  );
  const fs = { writeFileSync: vi.fn() } as unknown as Parameters<typeof createCaptureStore>[0]["fs"];
  const capture = createCaptureStore({ sessionId: "synthetic-process", outputFile: "synthetic-capture.json", fs });
  const record = vi.spyOn(capture, "record");
  const deps: MessagesDeps = {
    apiKey: "synthetic-provider",
    capture,
    resolveConversation: vi.fn(createSupabaseConversationResolver(db.client)),
    countTokens: vi.fn(async () => ({ input_tokens: 5, token_count_method: "exact", message_breakdown: [] })),
    tokenBudget: { tryConsume: vi.fn(async () => ({ allowed: true, limit: 100, remaining: 95 })) },
    forward: vi.fn(async () => ({ status: 200, data: { content: [{ type: "text", text: "synthetic response" }], usage: { input_tokens: 5, output_tokens: 2 } } })),
    forwardStream: vi.fn(async () => ({
      status: 200,
      stream: (async function* () {
        yield 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"usage":{"input_tokens":5}}}\n\n';
        yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"synthetic response"}}\n\n';
        yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      })(),
    })),
    usageOutbox: { enqueue: vi.fn(), close: vi.fn(async () => undefined) },
    recordUsage: vi.fn(async () => undefined),
    recordMemory: vi.fn(async () => undefined),
    observeConversation: vi.fn(async () => undefined),
    telemetry: vi.fn(),
  };
  app = buildProxy({
    cors: false,
    rateLimit: false,
    auth: { resolve: async (key) => (key === "synthetic-key" ? { orgId: "org", keyId: "key" } : null), protectedPrefixes: ["/v1/"] },
    messages: deps,
  });
  return { deps, record };
}

function send(mode: Mode, requestedId = ID) {
  return app!.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: "Bearer synthetic-key", "x-cq-conversation-id": requestedId, ...(mode === "stream accept" ? { accept: "text/event-stream" } : {}) },
    payload: { ...body, ...(mode === "stream body" ? { stream: true } : {}) },
  });
}

describe.each(modes)("message erasure identity boundary: %s", (mode) => {
  test.each([
    { label: "explicit session", kind: "explicit", requestedId: ID, status: 404 },
    { label: "foreign conversation", orgId: "foreign", requestedId: ID, status: 404 },
    { label: "malformed identity", requestedId: "invalid", status: 400 },
    { label: "unavailable identity lookup", lookupFails: true, requestedId: ID, status: 503 },
  ])("$label stops every downstream message operation", async ({ kind, orgId, lookupFails, requestedId, status }) => {
    const { deps, record } = harness(kind, lookupFails, orgId);
    const response = await send(mode, requestedId);
    expect(response.statusCode).toBe(status);
    expect(response.headers["x-cq-conversation-id"]).toBeUndefined();
    expect(deps.resolveConversation).toHaveBeenCalledOnce();
    expect(deps.countTokens).not.toHaveBeenCalled();
    expect(deps.tokenBudget!.tryConsume).not.toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
    expect(deps.forwardStream).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(deps.usageOutbox!.enqueue).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.recordMemory).not.toHaveBeenCalled();
    expect(deps.observeConversation).not.toHaveBeenCalled();
    expect(deps.telemetry).not.toHaveBeenCalled();
    expect(deps.capture.getSession().requests).toHaveLength(0);
    expect(response.body).not.toContain("select failed");
  });

  test("a bound conversation still counts, forwards, captures and journals normally", async () => {
    const { deps, record } = harness();
    const response = await send(mode);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-cq-conversation-id"]).toBe(ID);
    expect(deps.countTokens).toHaveBeenCalledOnce();
    expect(deps.tokenBudget!.tryConsume).toHaveBeenCalledOnce();
    expect(mode === "normal" ? deps.forward : deps.forwardStream).toHaveBeenCalledOnce();
    expect(mode === "normal" ? deps.forwardStream : deps.forward).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(deps.usageOutbox!.enqueue).toHaveBeenCalledOnce();
    expect(deps.recordMemory).toHaveBeenCalledOnce();
    expect(deps.observeConversation).toHaveBeenCalledOnce();
    if (mode !== "normal") expect(response.body).toContain("event: message_stop");
  });
});
