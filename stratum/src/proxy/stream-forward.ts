/**
 * Streaming forward to the upstream Anthropic Messages API (§2d P0-B).
 *
 * Uses axios `responseType: 'stream'` — the SAME axios transport as the
 * non-streaming path (per the Session-13 decision: one HTTP transport, NOT the
 * SDK's messages.stream(), to avoid a second forwarding paradigm in one file).
 *
 * Returns a discriminated result so the route can decide before writing any
 * bytes to the client:
 *   - 2xx → { status, stream } where stream yields raw SSE chunk strings.
 *   - non-2xx → { status, data } with the (collected, parsed) error body, so
 *     the route passes it through verbatim exactly like the non-streaming path.
 *   - network/transport failure → throws (route maps to 502).
 */

import axios from "axios";
import { resolveAnthropicBaseUrl, type ForwardHeaders, type MessagesBody } from "./forward";

export interface StreamForwardResult {
  status: number;
  /** Present on 2xx — raw SSE chunk strings from upstream, in order. */
  stream?: AsyncIterable<string>;
  /** Present on non-2xx — the collected + parsed error body (passed through). */
  data?: unknown;
}

/**
 * Forward a streaming request to Anthropic.
 *
 * @param body - the Anthropic request body (with stream:true).
 * @param apiKey - the Anthropic API key.
 * @param baseUrl - resolved upstream base URL.
 * @returns a {@link StreamForwardResult}.
 * @throws on network/transport errors (no HTTP response).
 */
export async function forwardStreamToAnthropic(
  body: MessagesBody,
  apiKey: string,
  baseUrl: string = resolveAnthropicBaseUrl(),
  passthrough?: ForwardHeaders,
): Promise<StreamForwardResult> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": passthrough?.anthropicVersion ?? "2023-06-01",
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (passthrough?.anthropicBeta !== undefined && passthrough.anthropicBeta !== "") {
    headers["anthropic-beta"] = passthrough.anthropicBeta;
  }
  const res = await axios.post(`${baseUrl}/v1/messages`, body, {
    headers,
    responseType: "stream",
    validateStatus: () => true,
  });

  const upstream = res.data as AsyncIterable<Buffer | string>;

  if (res.status >= 400) {
    // Collect the (non-stream) error body so the route can pass it through.
    let buf = "";
    for await (const chunk of upstream) buf += chunk.toString();
    let data: unknown;
    try {
      data = JSON.parse(buf);
    } catch {
      data = buf;
    }
    return { status: res.status, data };
  }

  async function* toStrings(): AsyncGenerator<string> {
    for await (const chunk of upstream) yield chunk.toString();
  }
  return { status: res.status, stream: toStrings() };
}

/** True if the request asked for streaming (body.stream or SSE Accept header). */
export function isStreamingRequest(body: MessagesBody, accept: string | undefined): boolean {
  const bodyStream = (body as unknown as { stream?: unknown }).stream === true;
  const acceptStream = typeof accept === "string" && accept.includes("text/event-stream");
  return bodyStream || acceptStream;
}
