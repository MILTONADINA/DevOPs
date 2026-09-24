import { afterEach, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MessagesDeps } from "../../src/proxy/forward";

vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");
const { createCaptureStore } = await import("../../src/proxy/capture");
let app: FastifyInstance | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

function deps() {
  const memory = vi.fn(async () => undefined);
  const capture = createCaptureStore({ sessionId: "capture-only", outputFile: "/tmp/capture-only.json",
    fs: { writeFileSync: () => undefined } });
  const messages = {
    apiKey: "",
    capture,
    countTokens: async () => ({ input_tokens: 2, token_count_method: "exact" as const, message_breakdown: [] }),
    forward: async () => ({ status: 200, data: { content: [{ type: "text", text: "assistant answer" }], usage: { input_tokens: 2, output_tokens: 3 } } }),
    forwardStream: async () => ({ status: 200, stream: (async function* () {
      yield 'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\n';
      yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"assistant answer"}}\n\n';
      yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    })() }),
    recordMemory: memory,
  } as MessagesDeps & { recordMemory: typeof memory };
  return { messages, memory };
}

const payload = { model: "local/check", messages: [
  { role: "user", content: "old question" }, { role: "assistant", content: "old answer" },
  { role: "user", content: "latest question" },
], max_tokens: 32 };
const auth = { resolve: async (key: string) => key === "good" ? { orgId: "trusted-org", keyId: "key-id" } : null };
const boundAuth = { resolve: async (key: string) => key === "bound" ?
  { orgId: "trusted-org", keyId: "key-bound", projectScopeId: "trusted-org/orion" } : null };

test("successful nonstreaming request sends only the final turn with the authenticated org", async () => {
  const { messages, memory } = deps();
  app = buildProxy({ cors: false, rateLimit: false, auth, messages });
  const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload });
  expect(response.statusCode).toBe(200);
  expect(memory).toHaveBeenCalledExactlyOnceWith({ orgId: "trusted-org", model: "local/check",
    turns: [{ role: "user", content: "latest question" }, { role: "assistant", content: "assistant answer" }] });
});

test("successful stream sends the completed final turn; unauthenticated requests do not", async () => {
  const { messages, memory } = deps();
  app = buildProxy({ cors: false, rateLimit: false, auth, messages });
  const denied = await app.inject({ method: "POST", url: "/v1/messages", payload: { ...payload, stream: true } });
  expect(denied.statusCode).toBe(401);
  const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload: { ...payload, stream: true } });
  expect(response.statusCode).toBe(200);
  expect(memory).toHaveBeenCalledExactlyOnceWith({ orgId: "trusted-org", model: "local/check",
    turns: [{ role: "user", content: "latest question" }, { role: "assistant", content: "assistant answer" }] });
});

test.each([false, true])("a bound key carries trusted project scope into a completed memory event (stream=%s)", async (stream) => {
  const { messages, memory } = deps();
  app = buildProxy({ cors: false, rateLimit: false, auth: boundAuth, messages });
  const response = await app.inject({ method: "POST", url: "/v1/messages?project-scope=vega",
    headers: { authorization: "Bearer bound", "x-project-scope": "vega" }, payload: { ...payload, stream } });
  expect(response.statusCode).toBe(200);
  expect(memory).toHaveBeenCalledExactlyOnceWith({ orgId: "trusted-org", projectScopeId: "trusted-org/orion", model: "local/check",
    turns: [{ role: "user", content: "latest question" }, { role: "assistant", content: "assistant answer" }] });
});

test.each([false, true])("commercial memory uses the verified conversation and authenticated key (stream=%s)", async (stream) => {
  const { messages, memory } = deps();
  const conversationId = "c68f130e-c584-43fa-aefe-7b2e54aa34a8";
  messages.resolveConversation = async () => conversationId;
  app = buildProxy({ cors: false, rateLimit: false, auth: boundAuth, messages });
  const response = await app.inject({ method: "POST", url: "/v1/messages?conversation_id=forged&project-scope=vega",
    headers: { authorization: "Bearer bound", "x-project-scope": "vega", "x-cq-conversation-id": "c492b37d-4673-4d59-8ae8-63e1c0eef96a" },
    payload: { ...payload, stream, conversation_id: "forged", project_scope: "vega" } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["x-cq-conversation-id"]).toBe(conversationId);
  expect(memory).toHaveBeenCalledExactlyOnceWith({ orgId: "trusted-org", projectScopeId: "trusted-org/orion",
    conversationId, keyId: "key-bound", model: "local/check",
    turns: [{ role: "user", content: "latest question" }, { role: "assistant", content: "assistant answer" }] });
});

test("an SSE error after partial assistant text does not create a memory write", async () => {
  const { messages, memory } = deps();
  messages.forwardStream = async () => ({ status: 200, stream: (async function* () {
    yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"partial"}}\n\n';
    yield 'event: error\ndata: {"type":"error","error":{"message":"upstream failed"}}\n\n';
  })() });
  app = buildProxy({ cors: false, rateLimit: false, auth, messages });
  const response = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload: { ...payload, stream: true } });
  expect(response.statusCode).toBe(200);
  expect(memory).not.toHaveBeenCalled();
});

test("graceful close waits for an in-flight memory write", async () => {
  const { messages } = deps();
  let release!: () => void;
  messages.recordMemory = async () => new Promise<void>((resolve) => { release = resolve; });
  app = buildProxy({ cors: false, rateLimit: false, auth, messages });
  await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload });
  let closed = false;
  const close = app.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await close;
  expect(closed).toBe(true);
  app = undefined;
});

test("upstream rejection and memory failure do not alter the upstream response", async () => {
  const { messages, memory } = deps();
  messages.forward = async () => ({ status: 429, data: { type: "error", error: { message: "upstream limit" } } });
  app = buildProxy({ cors: false, rateLimit: false, auth, messages });
  const rejected = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload });
  expect(rejected.statusCode).toBe(429);
  expect(memory).not.toHaveBeenCalled();
  await app.close();

  const second = deps();
  second.messages.recordMemory = async () => { throw new Error("local model unavailable"); };
  app = buildProxy({ cors: false, rateLimit: false, auth, messages: second.messages });
  const successful = await app.inject({ method: "POST", url: "/v1/messages", headers: { authorization: "Bearer good" }, payload });
  expect(successful.statusCode).toBe(200);
  expect(successful.json().content[0].text).toBe("assistant answer");
  await app.close();
  app = undefined;
});
