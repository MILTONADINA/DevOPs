// Tests for the OpenAI-compatible provider transport beyond the basic forward path (ADR-0019): header
// construction (extraHeaders), 401/403 non-disclosure, error-body fallbacks, and the whole streaming path
// (request shape, SSE re-emit, error-body buffering, mid-stream failure closing, idle-timer lifecycle).

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("axios", () => {
  const post = vi.fn();
  return { default: { post, isCancel: (e: unknown) => (e as { __cancel?: boolean } | null)?.__cancel === true } };
});
import axios from "axios";
import { openAIProvider } from "../../src/proxy/providers/openai";
import type { ProviderCredentials } from "../../src/proxy/providers/types";
import type { MessagesBody } from "../../src/proxy/forward";

const post = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post;
const BODY: MessagesBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 16 };
const CREDS: ProviderCredentials = { apiKey: "synthetic-key", baseUrl: "https://llm.example.test/v1" };

beforeEach(() => post.mockReset());
afterEach(() => {
  vi.useRealTimers();
  delete process.env["CQ_UPSTREAM_IDLE_MS"];
  delete process.env["CQ_UPSTREAM_TIMEOUT_MS"];
});

async function* chunks(parts: Array<string | Buffer | Error>): AsyncGenerator<string | Buffer> {
  for (const p of parts) {
    if (p instanceof Error) throw p;
    yield p;
  }
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const textChunk = (t: string, finish?: string): unknown => ({ choices: [{ index: 0, delta: { content: t }, ...(finish ? { finish_reason: finish } : {}) }] });
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const s of stream) out += s;
  return out;
}
const streamOf = (r: unknown): AsyncIterable<string> => (r as { stream: AsyncIterable<string> }).stream;

describe("openAIProvider headers and errors (non-streaming)", () => {
  test("extraHeaders are merged in (OpenRouter referer/title) alongside Bearer auth", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: { choices: [{ message: { content: "x" }, finish_reason: "stop" }] } });
    await openAIProvider.forward("m", BODY, { ...CREDS, extraHeaders: { "HTTP-Referer": "https://app.example.test", "X-Title": "demo" } });
    const h = (post.mock.calls[0]![2] as { headers: Record<string, string> }).headers;
    expect(h).toMatchObject({ authorization: "Bearer synthetic-key", "content-type": "application/json", "HTTP-Referer": "https://app.example.test", "X-Title": "demo" });
  });

  test("the request timeout honours CQ_UPSTREAM_TIMEOUT_MS", async () => {
    process.env["CQ_UPSTREAM_TIMEOUT_MS"] = "4321";
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
    await openAIProvider.forward("m", BODY, CREDS);
    expect((post.mock.calls[0]![2] as { timeout: number }).timeout).toBe(4321);
  });

  test.each([401, 403])("a %i never echoes the upstream body (OpenAI embeds a key fragment there)", async (status) => {
    post.mockResolvedValueOnce({ status, headers: {}, data: { error: { message: "Incorrect API key provided: sk-SECRET-FRAGMENT" } } });
    const res = await openAIProvider.forward("m", BODY, CREDS);
    expect(res.status).toBe(status);
    expect((res.data as { error: { type: string } }).error.type).toBe("authentication_error");
    expect(JSON.stringify(res.data)).not.toContain("sk-SECRET-FRAGMENT");
  });

  test("non-429 errors are api_error; bodies without a string message fall back to a generic text", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: { error: { message: "boom" } } });
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: { error: { message: 7 } } });
    post.mockResolvedValueOnce({ status: 502, headers: {}, data: null });
    post.mockResolvedValueOnce({ status: 503, headers: {}, data: "gateway text" });
    post.mockResolvedValueOnce({ status: 504, headers: {}, data: "" });
    const errs = [];
    for (let i = 0; i < 5; i++) errs.push(((await openAIProvider.forward("m", BODY, CREDS)).data as { error: { type: string; message: string } }).error);
    expect(errs).toEqual([
      { type: "api_error", message: "boom" },
      { type: "api_error", message: "upstream error (HTTP 500)" },
      { type: "api_error", message: "upstream error (HTTP 502)" },
      { type: "api_error", message: "gateway text" },
      { type: "api_error", message: "upstream error (HTTP 504)" },
    ]);
  });

  test("a transport rejection propagates", async () => {
    post.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(openAIProvider.forward("m", BODY, CREDS)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("openAIProvider.forwardStream", () => {
  test("posts a stream request: stream flag, SSE accept header, stream responseType, abort signal, extra headers", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, { ...CREDS, extraHeaders: { "X-Title": "demo" } });
    await drain(streamOf(r));
    const [url, reqBody, opts] = post.mock.calls[0]!;
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect((reqBody as { stream?: boolean }).stream).toBe(true);
    const o = opts as { headers: Record<string, string>; responseType: string; signal: AbortSignal };
    expect(o.responseType).toBe("stream");
    expect(o.headers).toMatchObject({ accept: "text/event-stream", authorization: "Bearer synthetic-key", "X-Title": "demo" });
    expect(o.signal).toBeInstanceOf(AbortSignal);
  });

  test("re-emits OpenAI deltas as Anthropic SSE, tolerating an event split across chunks and the [DONE] sentinel", async () => {
    const wire = sse(textChunk("Hel")) + sse(textChunk("lo", "stop")) + sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + "data: [DONE]\n\n";
    const cut = sse(textChunk("Hel")).length + 7;
    post.mockResolvedValueOnce({ status: 200, headers: { "X-A": "b" }, data: chunks([Buffer.from(wire.slice(0, cut)), wire.slice(cut)]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({ "x-a": "b" });
    const out = await drain(streamOf(r));
    expect(out).toContain("message_start");
    expect(out.indexOf('"text":"Hel"')).toBeGreaterThan(-1);
    expect(out.indexOf('"text":"Hel"')).toBeLessThan(out.indexOf('"text":"lo"'));
    expect(out).toContain("message_stop");
    expect(out.match(/event: message_stop/g)).toHaveLength(1);
  });

  test("a final event without a trailing blank line is flushed, not dropped", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([`data: ${JSON.stringify(textChunk("tail", "stop"))}`]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect(await drain(streamOf(r))).toContain('"text":"tail"');
  });

  test("a mid-stream upstream error still closes the Anthropic stream with message_stop, then rethrows", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([sse(textChunk("partial")), new Error("socket hang up")]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const s of streamOf(r)) seen.push(s);
      })(),
    ).rejects.toThrow("socket hang up");
    expect(seen.join("")).toContain("partial");
    expect(seen.join("")).toContain("message_stop");
  });

  test("a >=400 stream is buffered across chunks and translated to a JSON Anthropic error", async () => {
    post.mockResolvedValueOnce({ status: 429, headers: { "Retry-After": "3" }, data: chunks(['{"error":{"mess', 'age":"too fast"}}']) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect(r).toEqual({ status: 429, data: { type: "error", error: { type: "rate_limit_error", message: "too fast" } }, headers: { "retry-after": "3" } });
  });

  test("a non-JSON error body becomes the message text", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["upstream exploded"]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect((r as { data: { error: { message: string } } }).data.error.message).toBe("upstream exploded");
  });

  test("a streamed 401/403 body is never forwarded verbatim", async () => {
    post.mockResolvedValueOnce({ status: 401, headers: {}, data: chunks(['{"error":{"message":"Incorrect API key provided: sk-SECRET-FRAGMENT"}}']) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect(JSON.stringify((r as { data: unknown }).data)).not.toContain("sk-SECRET-FRAGMENT");
    expect((r as { data: { error: { type: string } } }).data.error.type).toBe("authentication_error");
  });

  test("a non-abort failure while reading an error body propagates", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["x", new Error("read failed")]) });
    await expect(openAIProvider.forwardStream!("gpt-4o", BODY, CREDS)).rejects.toThrow("read failed");
  });

  test.each([
    ["AbortError", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["axios cancel", Object.assign(new Error("canceled"), { __cancel: true })],
  ])("an abort (%s) while reading an error body is swallowed and the partial body translated", async (_n, abort) => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["partial text", abort]) });
    const r = await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect((r as { status: number }).status).toBe(500);
    expect((r as { data: { error: { message: string } } }).data.error.message).toBe("partial text");
  });

  test("a connect failure rejects and leaves no idle timer armed", async () => {
    vi.useFakeTimers();
    post.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(openAIProvider.forwardStream!("gpt-4o", BODY, CREDS)).rejects.toThrow("ENOTFOUND");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the idle timer aborts the request signal after CQ_UPSTREAM_IDLE_MS of silence, not before", async () => {
    vi.useFakeTimers();
    process.env["CQ_UPSTREAM_IDLE_MS"] = "500";
    let signal: AbortSignal | undefined;
    post.mockImplementationOnce(async (_u: string, _b: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal;
      return { status: 200, headers: {}, data: chunks([]) };
    });
    await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    await vi.advanceTimersByTimeAsync(499);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal!.aborted).toBe(true);
  });

  test("the idle timer is cleared when the stream completes and when the error body has been read", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([sse(textChunk("a", "stop"))]) });
    await drain(streamOf(await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS)));
    expect(vi.getTimerCount()).toBe(0);
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["err"]) });
    await openAIProvider.forwardStream!("gpt-4o", BODY, CREDS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
