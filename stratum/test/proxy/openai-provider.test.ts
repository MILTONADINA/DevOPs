// Tests for the OpenAI-compatible provider transport (ADR-0019) with a mocked axios: the non-streaming
// forward translates request->OpenAI and response->Anthropic, the error path returns an Anthropic error
// (with headers for retry), and a keyless local server omits the Authorization header.

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => {
  const post = vi.fn();
  return { default: { post, isCancel: () => false } };
});
import axios from "axios";
import { openAIProvider } from "../../src/proxy/providers/openai";
import type { ProviderCredentials } from "../../src/proxy/providers/types";
import type { MessagesBody } from "../../src/proxy/forward";

const post = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post;
const BODY: MessagesBody = { model: "gpt-4o", system: "be terse", messages: [{ role: "user", content: "hi" }], max_tokens: 32 };

beforeEach(() => post.mockReset());

describe("openAIProvider.forward (non-streaming)", () => {
  test("POSTs translated body to {baseUrl}/chat/completions with Bearer auth; returns an Anthropic message", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: { id: "chatcmpl-1", model: "gpt-4o", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } } });
    const creds: ProviderCredentials = { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" };
    const res = await openAIProvider.forward("gpt-4o", BODY, creds);

    // URL + auth + translated body
    const [url, reqBody, opts] = post.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((opts as { headers: Record<string, string> }).headers["authorization"]).toBe("Bearer sk-test");
    const sent = reqBody as Record<string, unknown>;
    expect((sent["messages"] as Record<string, unknown>[])[0]).toEqual({ role: "system", content: "be terse" });
    expect(sent["max_tokens"]).toBe(32);

    // Anthropic-shaped result
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 9, output_tokens: 1 } });
  });

  test("a 429 returns an Anthropic rate_limit_error and preserves headers (so retry honors Retry-After)", async () => {
    post.mockResolvedValueOnce({ status: 429, headers: { "retry-after": "5" }, data: { error: { message: "slow down" } } });
    const res = await openAIProvider.forward("gpt-4o", BODY, { apiKey: "sk", baseUrl: "https://api.openai.com/v1" });
    expect(res.status).toBe(429);
    expect(res.data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    expect(res.headers?.["retry-after"]).toBe("5");
  });

  test("a keyless local server omits the Authorization header", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} } });
    await openAIProvider.forward("llama3.1", BODY, { apiKey: "", baseUrl: "http://localhost:11434/v1" });
    const opts = post.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(opts.headers["authorization"]).toBeUndefined();
    expect(opts.headers["content-type"]).toBe("application/json");
  });
});
