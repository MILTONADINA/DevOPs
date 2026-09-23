/**
 * Google Gemini provider adapter (ADR-0019). Calls the generateContent / streamGenerateContent endpoints
 * with `x-goog-api-key` auth; translation to/from the Anthropic shape lives in translate-gemini.ts. This
 * module is the transport (auth, timeouts, streaming idle-abort, SSE re-emit), mirroring the others.
 */

import axios from "axios";
import { upstreamIdleMs, upstreamTimeoutMs, type ForwardHeaders, type ForwardResult, type MessagesBody } from "../forward";
import { createSseParser } from "../sse";
import type { StreamForwardResult } from "../stream-forward";
import { isAbort, lowerHeaders } from "./http";
import { anthropicToGeminiRequest, createGeminiStreamTranslator, geminiResponseToAnthropic } from "./translate-gemini";
import type { Provider, ProviderCredentials } from "./types";

/** Translate a non-2xx Gemini error body into an Anthropic-shaped error object. AUTH errors (401/403) are
 *  never forwarded verbatim (defense-in-depth — keep upstream key/credential detail out of client responses). */
function geminiErrorToAnthropic(status: number, data: unknown): { type: "error"; error: { type: string; message: string } } {
  if (status === 401 || status === 403) {
    return { type: "error", error: { type: "authentication_error", message: `upstream authentication error (HTTP ${status}) — check the provider API key configured on the proxy` } };
  }
  let message = `upstream error (HTTP ${status})`;
  if (typeof data === "string" && data !== "") message = data;
  else {
    const d = data as { error?: { message?: unknown } } | null;
    if (d !== null && typeof d === "object" && d.error && typeof d.error.message === "string") message = d.error.message;
  }
  return { type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } };
}

function authHeaders(creds: ProviderCredentials): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": creds.apiKey };
}

export const geminiProvider: Provider = {
  name: "gemini",

  async forward(model: string, body: MessagesBody, creds: ProviderCredentials, _passthrough?: ForwardHeaders): Promise<ForwardResult> {
    const url = `${creds.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await axios.post(url, anthropicToGeminiRequest(body), {
      headers: authHeaders(creds),
      validateStatus: () => true,
      timeout: upstreamTimeoutMs(),
    });
    const headers = lowerHeaders(res.headers);
    if (res.status >= 400) return { status: res.status, data: geminiErrorToAnthropic(res.status, res.data), headers };
    return { status: res.status, data: geminiResponseToAnthropic(model, res.data), headers };
  },

  async forwardStream(model: string, body: MessagesBody, creds: ProviderCredentials, _passthrough?: ForwardHeaders): Promise<StreamForwardResult> {
    const url = `${creds.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const idleMs = upstreamIdleMs();
    const ac = new AbortController();
    let idle: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(), idleMs);
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), idleMs);
    };

    let res;
    try {
      res = await axios.post(url, anthropicToGeminiRequest(body), {
        headers: { ...authHeaders(creds), accept: "text/event-stream" },
        responseType: "stream",
        validateStatus: () => true,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(idle);
      throw e;
    }

    const upstream = res.data as AsyncIterable<Buffer | string>;
    const respHeaders = lowerHeaders(res.headers);

    if (res.status >= 400) {
      let buf = "";
      try {
        for await (const chunk of upstream) {
          rearm();
          buf += chunk.toString();
        }
      } catch (e) {
        if (!isAbort(e)) {
          clearTimeout(idle);
          throw e;
        }
      } finally {
        clearTimeout(idle);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buf);
      } catch {
        parsed = buf;
      }
      return { status: res.status, data: geminiErrorToAnthropic(res.status, parsed), headers: respHeaders };
    }

    const parser = createSseParser();
    const translator = createGeminiStreamTranslator(model);
    async function* toAnthropicSSE(): AsyncGenerator<string> {
      try {
        for await (const chunk of upstream) {
          rearm();
          for (const ev of parser.push(chunk.toString())) for (const s of translator.push(ev.data)) yield s;
        }
        for (const ev of parser.flush()) for (const s of translator.push(ev.data)) yield s;
      } finally {
        // Emit closing events in finally so a mid-stream upstream error/abort still yields a well-formed
        // message_delta+message_stop (end()'s `ended` guard prevents duplicates on the normal path).
        for (const s of translator.end()) yield s;
        clearTimeout(idle);
      }
    }
    return { status: res.status, stream: toAnthropicSSE(), headers: respHeaders };
  },
};
