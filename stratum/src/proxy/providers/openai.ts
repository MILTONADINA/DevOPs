/**
 * OpenAI-compatible provider adapter (ADR-0019) — serves OpenAI, OpenRouter, and local servers
 * (Ollama / LM Studio / vLLM / llama.cpp), which all speak `POST {baseUrl}/chat/completions`. The three
 * differ only by base URL, key, and a couple of optional headers (OpenRouter's HTTP-Referer / X-Title) —
 * all supplied via {@link ProviderCredentials} — so ONE adapter covers them. Translation to/from the
 * Anthropic shape lives in translate-openai.ts; this module is the transport (auth, timeouts, streaming
 * idle-abort, SSE re-emit), mirroring the Anthropic transport's resilience.
 */

import axios from "axios";
import { upstreamIdleMs, upstreamTimeoutMs, type ForwardHeaders, type ForwardResult, type MessagesBody } from "../forward";
import { createSseParser } from "../sse";
import type { StreamForwardResult } from "../stream-forward";
import { isAbort, lowerHeaders } from "./http";
import { anthropicToOpenAIRequest, createOpenAIStreamTranslator, openAIResponseToAnthropic } from "./translate-openai";
import type { Provider, ProviderCredentials } from "./types";

/** Build request headers: Bearer auth (omitted for a keyless local server) + content-type + any extras. */
function buildHeaders(creds: ProviderCredentials): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (creds.apiKey !== "") h["authorization"] = `Bearer ${creds.apiKey}`;
  if (creds.extraHeaders !== undefined) Object.assign(h, creds.extraHeaders);
  return h;
}

/** Translate a non-2xx OpenAI error body into an Anthropic-shaped error object (the client always sees Anthropic).
 *  AUTH errors (401/403) are NEVER forwarded verbatim — OpenAI 401 bodies embed a fragment of the API key
 *  ("Incorrect API key provided: sk-…"), so echoing them would leak the operator's upstream key to clients. */
function openAIErrorToAnthropic(status: number, data: unknown): { type: "error"; error: { type: string; message: string } } {
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

export const openAIProvider: Provider = {
  name: "openai-compatible",

  async forward(model: string, body: MessagesBody, creds: ProviderCredentials, _passthrough?: ForwardHeaders): Promise<ForwardResult> {
    const reqBody = anthropicToOpenAIRequest(model, body, false);
    const res = await axios.post(`${creds.baseUrl}/chat/completions`, reqBody, {
      headers: buildHeaders(creds),
      validateStatus: () => true,
      timeout: upstreamTimeoutMs(),
    });
    const headers = lowerHeaders(res.headers);
    if (res.status >= 400) return { status: res.status, data: openAIErrorToAnthropic(res.status, res.data), headers };
    return { status: res.status, data: openAIResponseToAnthropic(model, res.data), headers };
  },

  async forwardStream(model: string, body: MessagesBody, creds: ProviderCredentials, _passthrough?: ForwardHeaders): Promise<StreamForwardResult> {
    const reqBody = anthropicToOpenAIRequest(model, body, true);
    const idleMs = upstreamIdleMs();
    const ac = new AbortController();
    let idle: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(), idleMs);
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), idleMs);
    };

    let res;
    try {
      res = await axios.post(`${creds.baseUrl}/chat/completions`, reqBody, {
        headers: { ...buildHeaders(creds), accept: "text/event-stream" },
        responseType: "stream",
        validateStatus: () => true,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(idle);
      throw e; // connect/network error → caller (withStreamRetry) decides
    }

    const upstream = res.data as AsyncIterable<Buffer | string>;
    const respHeaders = lowerHeaders(res.headers);

    if (res.status >= 400) {
      // Collect + translate the (non-stream) error body so the route passes an Anthropic error through.
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
      return { status: res.status, data: openAIErrorToAnthropic(res.status, parsed), headers: respHeaders };
    }

    // 2xx: translate the OpenAI SSE into Anthropic SSE chunk strings on the fly.
    const parser = createSseParser();
    const translator = createOpenAIStreamTranslator(model);
    async function* toAnthropicSSE(): AsyncGenerator<string> {
      try {
        for await (const chunk of upstream) {
          rearm(); // bytes arrived → reset the idle timer
          for (const ev of parser.push(chunk.toString())) for (const s of translator.push(ev.data)) yield s;
        }
        for (const ev of parser.flush()) for (const s of translator.push(ev.data)) yield s;
      } finally {
        // Emit the closing events in finally so they're produced even if the upstream stream errors/aborts
        // mid-flight — the client always gets a well-formed message_delta+message_stop (with whatever usage
        // arrived), and any usage collected before an abort is not lost. end()'s `ended` guard prevents dups.
        for (const s of translator.end()) yield s;
        clearTimeout(idle); // stream ended / consumer stopped → disarm
      }
    }
    return { status: res.status, stream: toAnthropicSSE(), headers: respHeaders };
  },
};
