// Tests for the Gemini provider transport (ADR-0019) with a mocked axios: URL/auth construction, error
// translation (auth detail never forwarded), the streaming error-body path, SSE re-emit, and the
// idle-abort / mid-stream-failure behaviour that must still close the Anthropic stream cleanly.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("axios", () => {
  const post = vi.fn();
  return { default: { post, isCancel: (e: unknown) => (e as { __cancel?: boolean } | null)?.__cancel === true } };
});
import axios from "axios";
import { geminiProvider } from "../../src/proxy/providers/gemini";
import type { ProviderCredentials } from "../../src/proxy/providers/types";
import type { MessagesBody } from "../../src/proxy/forward";

const post = (axios as unknown as { post: ReturnType<typeof vi.fn> }).post;
const BODY: MessagesBody = { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }], max_tokens: 16 };
const CREDS: ProviderCredentials = { apiKey: "synthetic-key", baseUrl: "https://gemini.example.test/v1beta" };

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
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const s of stream) out += s;
  return out;
}

describe("geminiProvider.forward (non-streaming)", () => {
  test("POSTs to models/{encoded model}:generateContent with x-goog-api-key, never a Bearer header", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: { "X-Req": "1" }, data: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } } });
    const res = await geminiProvider.forward("models/odd name", BODY, CREDS);
    const [url, , opts] = post.mock.calls[0]!;
    expect(url).toBe("https://gemini.example.test/v1beta/models/models%2Fodd%20name:generateContent");
    const h = (opts as { headers: Record<string, string> }).headers;
    expect(h["x-goog-api-key"]).toBe("synthetic-key");
    expect(h["authorization"]).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "x-req": "1" });
    expect(res.data).toMatchObject({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 4, output_tokens: 1 } });
  });

  test("the request timeout honours CQ_UPSTREAM_TIMEOUT_MS", async () => {
    process.env["CQ_UPSTREAM_TIMEOUT_MS"] = "1234";
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
    await geminiProvider.forward("m", BODY, CREDS);
    expect((post.mock.calls[0]![2] as { timeout: number }).timeout).toBe(1234);
  });

  test.each([401, 403])("a %i is replaced with a generic authentication_error that leaks no upstream detail", async (status) => {
    post.mockResolvedValueOnce({ status, headers: {}, data: { error: { message: "API key AIza-SECRET-VALUE is invalid" } } });
    const res = await geminiProvider.forward("m", BODY, CREDS);
    expect(res.status).toBe(status);
    const err = (res.data as { error: { type: string; message: string } }).error;
    expect(err.type).toBe("authentication_error");
    expect(err.message).toContain(`HTTP ${status}`);
    expect(JSON.stringify(res.data)).not.toContain("AIza-SECRET-VALUE");
  });

  test("429 -> rate_limit_error carrying the upstream message; headers kept for Retry-After", async () => {
    post.mockResolvedValueOnce({ status: 429, headers: { "Retry-After": "7" }, data: { error: { message: "quota" } } });
    const res = await geminiProvider.forward("m", BODY, CREDS);
    expect(res.data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "quota" } });
    expect(res.headers?.["retry-after"]).toBe("7");
  });

  test("other errors -> api_error; falls back to a generic message for non-conforming bodies", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: { error: { message: 42 } } });
    post.mockResolvedValueOnce({ status: 502, headers: {}, data: null });
    post.mockResolvedValueOnce({ status: 503, headers: {}, data: "plain text body" });
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: "" });
    const msgs = [];
    for (let i = 0; i < 4; i++) msgs.push(((await geminiProvider.forward("m", BODY, CREDS)).data as { error: { type: string; message: string } }).error);
    expect(msgs[0]).toEqual({ type: "api_error", message: "upstream error (HTTP 500)" });
    expect(msgs[1]).toEqual({ type: "api_error", message: "upstream error (HTTP 502)" });
    expect(msgs[2]).toEqual({ type: "api_error", message: "plain text body" });
    expect(msgs[3]).toEqual({ type: "api_error", message: "upstream error (HTTP 500)" });
  });

  test("a transport rejection propagates to the caller", async () => {
    post.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(geminiProvider.forward("m", BODY, CREDS)).rejects.toThrow("ECONNRESET");
  });
});

describe("geminiProvider.forwardStream", () => {
  test("requests streamGenerateContent?alt=sse with stream responseType and an abort signal", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([]) });
    const r = await geminiProvider.forwardStream!("gemini-2.5-pro", BODY, CREDS);
    await drain((r as { stream: AsyncIterable<string> }).stream);
    const [url, , opts] = post.mock.calls[0]!;
    expect(url).toBe("https://gemini.example.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    const o = opts as { headers: Record<string, string>; responseType: string; signal: AbortSignal };
    expect(o.responseType).toBe("stream");
    expect(o.headers["accept"]).toBe("text/event-stream");
    expect(o.headers["x-goog-api-key"]).toBe("synthetic-key");
    expect(o.signal).toBeInstanceOf(AbortSignal);
  });

  test("re-emits Gemini chunks as Anthropic SSE, tolerating events split across chunk boundaries", async () => {
    const first = sse({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] });
    const second = sse({ candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
    const wire = first + second;
    const cut = first.length + 10; // split inside the second event
    post.mockResolvedValueOnce({ status: 200, headers: { "X-A": "b" }, data: chunks([Buffer.from(wire.slice(0, cut)), wire.slice(cut)]) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({ "x-a": "b" });
    const out = await drain((r as { stream: AsyncIterable<string> }).stream);
    expect(out).toContain("message_start");
    expect(out).toContain('"text":"Hel"');
    expect(out).toContain('"text":"lo"');
    expect(out).toContain("message_stop");
    expect(out.indexOf('"text":"Hel"')).toBeLessThan(out.indexOf('"text":"lo"'));
  });

  test("a mid-stream upstream error still closes the Anthropic stream with message_stop, then rethrows", async () => {
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([sse({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }), new Error("socket hang up")]) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const s of (r as { stream: AsyncIterable<string> }).stream) seen.push(s);
      })(),
    ).rejects.toThrow("socket hang up");
    const out = seen.join("");
    expect(out).toContain("partial");
    expect(out).toContain("message_stop");
  });

  test("a >=400 stream is buffered and translated to a JSON Anthropic error (no stream returned)", async () => {
    post.mockResolvedValueOnce({ status: 429, headers: { "Retry-After": "3" }, data: chunks(['{"error":{"mess', 'age":"too fast"}}']) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    expect(r).toEqual({ status: 429, data: { type: "error", error: { type: "rate_limit_error", message: "too fast" } }, headers: { "retry-after": "3" } });
  });

  test("a non-JSON error body is surfaced as the message text", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["upstream exploded"]) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    expect((r as { data: { error: { message: string } } }).data.error.message).toBe("upstream exploded");
  });

  test("a streamed 401/403 body is never forwarded verbatim", async () => {
    post.mockResolvedValueOnce({ status: 403, headers: {}, data: chunks(['{"error":{"message":"key AIza-SECRET-VALUE rejected"}}']) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    expect(JSON.stringify((r as { data: unknown }).data)).not.toContain("AIza-SECRET-VALUE");
    expect((r as { data: { error: { type: string } } }).data.error.type).toBe("authentication_error");
  });

  test("a non-abort failure while reading an error body propagates", async () => {
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["x", new Error("read failed")]) });
    await expect(geminiProvider.forwardStream!("m", BODY, CREDS)).rejects.toThrow("read failed");
  });

  test("an abort while reading an error body is swallowed and the partial body is translated", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    post.mockResolvedValueOnce({ status: 500, headers: {}, data: chunks(["partial text", abort]) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    expect((r as { status: number; data: { error: { message: string } } }).status).toBe(500);
    expect((r as { data: { error: { message: string } } }).data.error.message).toBe("partial text");
  });

  test("a failure before the response (connect error) rejects and does not leave the idle timer armed", async () => {
    vi.useFakeTimers();
    post.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(geminiProvider.forwardStream!("m", BODY, CREDS)).rejects.toThrow("ENOTFOUND");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the idle timer aborts the request signal after CQ_UPSTREAM_IDLE_MS of silence", async () => {
    vi.useFakeTimers();
    process.env["CQ_UPSTREAM_IDLE_MS"] = "500";
    let signal: AbortSignal | undefined;
    post.mockImplementationOnce(async (_u: string, _b: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal;
      return { status: 200, headers: {}, data: chunks([]) };
    });
    const pending = geminiProvider.forwardStream!("m", BODY, CREDS);
    await pending;
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal!.aborted).toBe(true);
  });

  test("the idle timer is cleared once the stream completes", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({ status: 200, headers: {}, data: chunks([sse({ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }] })]) });
    const r = await geminiProvider.forwardStream!("m", BODY, CREDS);
    await drain((r as { stream: AsyncIterable<string> }).stream);
    expect(vi.getTimerCount()).toBe(0);
  });
});
