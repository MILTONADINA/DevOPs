// Verifies the /v1/messages route persists commercial usage correctly: recordUsage fires AFTER a
// successful forward (with the authenticated org + measured tokens), is skipped on upstream errors and
// zero-token counts, and is FAIL-OPEN (a recorder error never breaks the proxied response).

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");
const captureMod = await import("../../src/proxy/capture");
import type { MessagesDeps, ForwardResult, TokenCountResult } from "../../src/proxy/forward";
import type { UsageEvent } from "../../src/billing/usage-recorder";

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) { await app.close(); app = undefined; }
});

function deps(over: { forward?: MessagesDeps["forward"]; countTokens?: MessagesDeps["countTokens"]; recordUsage?: MessagesDeps["recordUsage"] } = {}): MessagesDeps {
  const fs = { writeFileSync: () => undefined } as unknown as Parameters<typeof captureMod.createCaptureStore>[0]["fs"];
  return {
    apiKey: "sk-ant-test",
    forward: over.forward ?? (async (): Promise<ForwardResult> => ({ status: 200, data: { usage: { output_tokens: 42 }, content: [] } })),
    forwardStream: async () => ({ status: 200, stream: undefined } as never),
    countTokens: over.countTokens ?? (async (): Promise<TokenCountResult> => ({ input_tokens: 8000, token_count_method: "exact", message_breakdown: [] })),
    capture: captureMod.createCaptureStore({ sessionId: "s", outputFile: "/tmp/s.json", fs }),
    ...(over.recordUsage ? { recordUsage: over.recordUsage } : {}),
  };
}

const AUTH = { resolve: async (k: string) => (k === "k1" ? { orgId: "org-7", keyId: "key-1" } : null), protectedPrefixes: ["/v1/"] };
const BODY = { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

function post(body: unknown = BODY, key = "k1") {
  return app!.inject({ method: "POST", url: "/v1/messages", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
}

describe("commercial usage persistence on /v1/messages", () => {
  test("records usage after a successful forward (org + measured tokens)", async () => {
    const calls: UsageEvent[] = [];
    app = buildProxy({ cors: false, rateLimit: false, auth: AUTH, messages: deps({ recordUsage: async (e) => void calls.push(e) }) });
    await app.ready();
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ orgId: "org-7", model: "claude-sonnet-4-6", inputTokens: 8000, outputTokens: 42 }]);
  });

  test("does NOT record on an upstream 4xx", async () => {
    const calls: UsageEvent[] = [];
    app = buildProxy({ cors: false, rateLimit: false, auth: AUTH, messages: deps({ forward: async () => ({ status: 429, data: { type: "error" } }), recordUsage: async (e) => void calls.push(e) }) });
    await app.ready();
    expect((await post()).statusCode).toBe(429);
    expect(calls).toHaveLength(0);
  });

  test("does NOT record a zero-token count (CHECK original_tokens > 0)", async () => {
    const calls: UsageEvent[] = [];
    app = buildProxy({ cors: false, rateLimit: false, auth: AUTH, messages: deps({ countTokens: async () => ({ input_tokens: 0, token_count_method: "estimated", message_breakdown: [] }), recordUsage: async (e) => void calls.push(e) }) });
    await app.ready();
    expect((await post()).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("is FAIL-OPEN: a recorder error never breaks the proxied response", async () => {
    app = buildProxy({ cors: false, rateLimit: false, auth: AUTH, messages: deps({ recordUsage: async () => { throw new Error("supabase down"); } }) });
    await app.ready();
    const res = await post();
    expect(res.statusCode).toBe(200); // the response still succeeds despite the recorder throwing
    expect(res.json()).toMatchObject({ usage: { output_tokens: 42 } });
  });
});
