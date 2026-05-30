// Tests for POST /v1/tokens/count via app.inject() with an injected fake counter.

import { describe, test, expect, vi } from "vitest";
import type { TokensDeps } from "../../src/proxy/routes/tokens";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

function fakeDeps(): { deps: TokensDeps; seen: { body?: unknown } } {
  const seen: { body?: unknown } = {};
  const deps: TokensDeps = {
    countTokens: (body) => {
      seen.body = body;
      return Promise.resolve({ input_tokens: 1234, token_count_method: "exact", message_breakdown: [] });
    },
  };
  return { deps, seen };
}

describe("POST /v1/tokens/count", () => {
  test("counts tokens for a {model, messages} body", async () => {
    const { deps, seen } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, tokens: deps });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/tokens/count", headers: { "content-type": "application/json" }, payload: { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ input_tokens: 1234, token_count_method: "exact" });
    expect(seen.body).toMatchObject({ model: "claude-opus-4-8" });
    await app.close();
  });

  test("400 on a malformed body (missing model or messages)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, tokens: fakeDeps().deps });
    await app.ready();
    const opts = { headers: { "content-type": "application/json" } };
    expect((await app.inject({ method: "POST", url: "/v1/tokens/count", ...opts, payload: { messages: [] } })).statusCode).toBe(400); // no model
    expect((await app.inject({ method: "POST", url: "/v1/tokens/count", ...opts, payload: { model: "x" } })).statusCode).toBe(400); // no messages
    expect((await app.inject({ method: "POST", url: "/v1/tokens/count", ...opts, payload: { model: "", messages: [] } })).statusCode).toBe(400); // empty model
    await app.close();
  });
});
