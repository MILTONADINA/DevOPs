import { afterEach, describe, expect, test, vi } from "vitest";
import { createLocalEvalCompletion, selectEvalProvider } from "../../evals/harness/metrics";
import { main as locomoMain } from "../../scripts/eval-locomo";
import { main as longMemMain } from "../../scripts/eval-longmemeval";

afterEach(() => vi.unstubAllEnvs());

function reply(content: unknown, finish_reason = "stop"): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason }] });
}

describe("local judged provider", () => {
  test("rejects non-loopback, URL credentials, and malformed local model IDs", () => {
    for (const base of [
      "https://127.0.0.1:1234/v1",
      "http://localhost:1234/v1",
      "http://2130706433:1234/v1",
      "http://0x7f000001:1234/v1",
      "http://example.com/v1",
      "http://u:p@127.0.0.1:1234/v1",
      "http://127.0.0.1:1234/v1?q=1",
    ]) {
      expect(() => createLocalEvalCompletion(base, "local/qwen-local")).toThrow(/loopback/i);
    }
    expect(() => createLocalEvalCompletion("http://127.0.0.1:1234/v1", "qwen-local")).toThrow(/local\/|EVAL_LOCAL_MODEL/);
  });

  test("sends a bounded non-thinking request and accepts text", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init ?? {};
      return reply("grounded answer");
    }) as typeof fetch;
    const completion = createLocalEvalCompletion("http://127.0.0.1:1234/v1", "local/qwen-local", fakeFetch);
    expect(await completion.complete("untrusted prompt", { maxTokens: 256 })).toBe("grounded answer");
    expect(seenUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(seenInit.redirect).toBe("error");
    expect(JSON.parse(String(seenInit.body))).toMatchObject({
      model: "qwen-local",
      max_tokens: 256,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: "untrusted prompt" }],
    });
  });

  test("fails on HTTP errors, truncated output, and missing text", async () => {
    const completeWith = (response: Response) => createLocalEvalCompletion("http://127.0.0.1:1234/v1", "local/qwen-local", vi.fn(async () => response) as typeof fetch).complete("test");
    await expect(completeWith(new Response("fail", { status: 500 }))).rejects.toThrow(/HTTP 500/);
    await expect(completeWith(reply("partial", "length"))).rejects.toThrow(/truncated/);
    await expect(completeWith(reply("partial", "content_filter"))).rejects.toThrow(/finish normally/);
    await expect(completeWith(reply(null))).rejects.toThrow(/no text/);
    await expect(completeWith(new Response("not json"))).rejects.toThrow(/invalid JSON/);
    await expect(completeWith(reply("x".repeat(70_000)))).rejects.toThrow(/exceeded 65536 bytes/);
  });

  test("partial local config cannot silently fall back to Claude", () => {
    expect(() => selectEvalProvider({ EVAL_LOCAL_BASE_URL: "http://127.0.0.1:1234/v1", ANTHROPIC_API_KEY: "fixture" })).toThrow(/EVAL_LOCAL_MODEL/);
    expect(selectEvalProvider({})).toBeNull();
    expect(selectEvalProvider({ EVAL_LOCAL_BASE_URL: "http://127.0.0.1:1234/v1", EVAL_LOCAL_MODEL: "local/qwen-local" })).toMatchObject({ label: "local/qwen-local", exploratory: true });
  });

  test("both published runners fail nonzero without a judged provider", async () => {
    vi.stubEnv("EVAL_LOCAL_BASE_URL", "");
    vi.stubEnv("EVAL_LOCAL_MODEL", "");
    vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await locomoMain()).toBe(1);
    expect(await longMemMain()).toBe(1);
  });
});
