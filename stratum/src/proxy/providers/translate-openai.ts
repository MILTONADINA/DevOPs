/**
 * Anthropic ⇄ OpenAI translation (ADR-0019) — PURE, no I/O, heavily unit-tested.
 *
 * The proxy speaks Anthropic to the client, so this module translates an Anthropic-shaped request OUT to
 * the OpenAI Chat Completions shape, and the OpenAI response/stream BACK to the Anthropic shape (a Message
 * object + Anthropic SSE events). One module serves OpenAI, OpenRouter, and any OpenAI-compatible local
 * server — they share the `/chat/completions` contract.
 *
 * Covered: system prompt, text, images (base64 → data-URL), tool definitions, assistant tool_use →
 * tool_calls, user tool_result → role:"tool" messages, finish-reason mapping, usage normalization, and
 * incremental streaming (text + tool-call deltas + final usage).
 */

import type { MessagesBody } from "../forward";

/* ----------------------------------- narrowing helpers ----------------------------------- */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse a JSON arguments string defensively; an unparseable/empty string yields {} (never throws). */
function safeJson(s: string | undefined): unknown {
  if (s === undefined || s === "") return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Flatten an Anthropic `system` (string OR array of text blocks) to a single string. */
function flattenSystem(system: unknown): string {
  if (typeof system === "string") return system;
  const arr = asArray(system);
  if (arr === null) return "";
  return arr
    .map((b) => {
      const r = asRecord(b);
      return r && asString(r["text"]) !== undefined ? (r["text"] as string) : "";
    })
    .join("");
}

/** OpenAI reasoning models reject `temperature` and want `max_completion_tokens` instead of `max_tokens`. */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /^o[0-9]/.test(m) || m.startsWith("gpt-5");
}

/* ----------------------------------- request: Anthropic → OpenAI ----------------------------------- */

/** One translated OpenAI content part (text or image_url). */
type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Translate an Anthropic image block's source into an OpenAI data-URL image part, or null if unsupported. */
function imagePart(block: Record<string, unknown>): OpenAIContentPart | null {
  const src = asRecord(block["source"]);
  if (src === null) return null;
  // base64 source → data URL. (URL sources pass straight through.)
  const mediaType = asString(src["media_type"]) ?? "image/png";
  const data = asString(src["data"]);
  if (src["type"] === "base64" && data !== undefined) return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
  const url = asString(src["url"]);
  if (url !== undefined) return { type: "image_url", image_url: { url } };
  return null;
}

/**
 * Translate an Anthropic-shaped request into an OpenAI Chat Completions request body.
 *
 * @param model - the provider-native model id (prefix already stripped).
 * @param body - the inbound Anthropic-shaped request (may carry extra fields like temperature).
 * @param stream - whether to request a streamed response.
 * @returns the OpenAI request body to POST to /chat/completions.
 */
export function anthropicToOpenAIRequest(model: string, body: MessagesBody, stream: boolean): Record<string, unknown> {
  const raw = body as unknown as Record<string, unknown>;
  const messages: Record<string, unknown>[] = [];

  const sys = flattenSystem(body.system);
  if (sys !== "") messages.push({ role: "system", content: sys });

  for (const msg of body.messages ?? []) {
    const role = msg.role;
    const content = msg.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    const blocks = asArray(content);
    if (blocks === null) {
      messages.push({ role, content: "" });
      continue;
    }

    const parts: OpenAIContentPart[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResults: { tool_call_id: string; content: string }[] = [];

    for (const b of blocks) {
      const blk = asRecord(b);
      if (blk === null) continue;
      const t = asString(blk["type"]);
      if (t === "text") {
        const text = asString(blk["text"]);
        if (text !== undefined) parts.push({ type: "text", text });
      } else if (t === "image") {
        const part = imagePart(blk);
        if (part !== null) parts.push(part);
      } else if (t === "tool_use") {
        // assistant tool call
        toolCalls.push({
          id: asString(blk["id"]) ?? "",
          type: "function",
          function: { name: asString(blk["name"]) ?? "", arguments: JSON.stringify(blk["input"] ?? {}) },
        });
      } else if (t === "tool_result") {
        // user-side result of a prior tool call → an OpenAI role:"tool" message
        const tcId = asString(blk["tool_use_id"]) ?? "";
        const rc = blk["content"];
        // tool_result content can be a string or an array of text blocks; flatten to text.
        let text = "";
        if (typeof rc === "string") text = rc;
        else {
          const rcArr = asArray(rc);
          if (rcArr !== null)
            text = rcArr
              .map((x) => {
                const r = asRecord(x);
                return r && asString(r["text"]) !== undefined ? (r["text"] as string) : "";
              })
              .join("");
        }
        toolResults.push({ tool_call_id: tcId, content: text });
      }
    }

    // Emit role:"tool" messages first (they answer the preceding assistant tool_calls), then the
    // text/image content of this turn (if any), then the assistant message's tool_calls (if any).
    for (const tr of toolResults) messages.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });

    if (role === "assistant" && toolCalls.length > 0) {
      const textOnly = parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      messages.push({ role: "assistant", ...(textOnly !== "" ? { content: textOnly } : { content: null }), tool_calls: toolCalls });
    } else if (parts.length > 0) {
      // A single text part collapses to a plain string (broadest compatibility incl. local servers).
      if (parts.length === 1 && parts[0]!.type === "text") messages.push({ role, content: parts[0]!.text });
      else messages.push({ role, content: parts });
    } else if (toolResults.length === 0) {
      messages.push({ role, content: "" });
    }
  }

  const out: Record<string, unknown> = { model, messages };

  // Token cap: reasoning models use max_completion_tokens and reject temperature.
  if (isReasoningModel(model)) {
    out["max_completion_tokens"] = body.max_tokens;
  } else {
    out["max_tokens"] = body.max_tokens;
    const temperature = asNumber(raw["temperature"]);
    if (temperature !== undefined) out["temperature"] = temperature;
    const topP = asNumber(raw["top_p"]);
    if (topP !== undefined) out["top_p"] = topP;
  }

  // stop_sequences → stop
  const stops = asArray(raw["stop_sequences"]);
  if (stops !== null && stops.length > 0) out["stop"] = stops.filter((s) => typeof s === "string");

  // tools: Anthropic {name, description, input_schema} → OpenAI {type:function, function:{name, description, parameters}}
  const tools = asArray(body.tools);
  if (tools !== null && tools.length > 0) {
    out["tools"] = tools
      .map((t) => {
        const r = asRecord(t);
        if (r === null) return null;
        return { type: "function", function: { name: asString(r["name"]) ?? "", description: asString(r["description"]) ?? "", parameters: r["input_schema"] ?? { type: "object" } } };
      })
      .filter((x) => x !== null);
  }

  if (stream) {
    out["stream"] = true;
    out["stream_options"] = { include_usage: true }; // so the final chunk carries prompt/completion tokens for billing
  }

  return out;
}

/* ----------------------------------- response: OpenAI → Anthropic ----------------------------------- */

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** An Anthropic-shaped Message object (the proxy's canonical response shape). */
export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Record<string, unknown>[];
  stop_reason: string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Translate an OpenAI Chat Completions response into an Anthropic Message.
 *
 * @param model - the model id to report (falls back to the request's model).
 * @param resp - the parsed OpenAI response object.
 * @returns an Anthropic-shaped Message.
 */
export function openAIResponseToAnthropic(model: string, resp: unknown): AnthropicMessage {
  const r = asRecord(resp) ?? {};
  const choices = asArray(r["choices"]) ?? [];
  const choice = asRecord(choices[0]) ?? {};
  const message = asRecord(choice["message"]) ?? {};
  const usage = asRecord(r["usage"]) ?? {};

  const content: Record<string, unknown>[] = [];
  const text = asString(message["content"]);
  if (text !== undefined && text !== "") content.push({ type: "text", text });
  const toolCalls = asArray(message["tool_calls"]);
  if (toolCalls !== null) {
    for (const tc of toolCalls) {
      const c = asRecord(tc);
      if (c === null) continue;
      const fn = asRecord(c["function"]) ?? {};
      content.push({ type: "tool_use", id: asString(c["id"]) ?? "", name: asString(fn["name"]) ?? "", input: safeJson(asString(fn["arguments"])) });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: asString(r["id"]) ?? "msg_openai",
    type: "message",
    role: "assistant",
    model: asString(r["model"]) ?? model,
    content,
    stop_reason: mapFinishReason(asString(choice["finish_reason"])),
    stop_sequence: null,
    usage: { input_tokens: asNumber(usage["prompt_tokens"]) ?? 0, output_tokens: asNumber(usage["completion_tokens"]) ?? 0 },
  };
}

/* ----------------------------------- streaming: OpenAI SSE → Anthropic SSE ----------------------------------- */

/** Build one Anthropic SSE chunk string (event line + data line + blank line); type is echoed into data. */
function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export interface OpenAIStreamTranslator {
  /** Translate one parsed OpenAI stream value (a chunk object, or the "[DONE]" sentinel string) → Anthropic SSE strings. */
  push(value: unknown): string[];
  /** Emit the closing Anthropic events (content_block_stop / message_delta / message_stop). */
  end(): string[];
}

/**
 * Create a stateful translator from OpenAI streamed chunks to Anthropic SSE events. Emits the canonical
 * Anthropic sequence: message_start → (content_block_start/_delta per text + tool call) → content_block_stop
 * → message_delta (stop_reason + usage) → message_stop. The final usage carries BOTH input_tokens (OpenAI
 * prompt_tokens) and output_tokens so the proxy can bill the exact upstream count (the accumulator merges
 * input_tokens from message_delta — see sse.ts).
 *
 * @param model - the model id to report in message_start.
 * @returns an {@link OpenAIStreamTranslator}.
 */
export function createOpenAIStreamTranslator(model: string): OpenAIStreamTranslator {
  let started = false;
  let ended = false;
  let textOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  const toolByOpenAIIndex = new Map<number, number>(); // OpenAI tool_call index → Anthropic content-block index
  let stopReason: string | undefined;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  let messageId = "msg_openai";

  function ensureStart(out: string[]): void {
    if (started) return;
    started = true;
    out.push(
      sse("message_start", {
        message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    );
  }

  return {
    push(value: unknown): string[] {
      const out: string[] = [];
      if (value === "[DONE]") return out; // closing handled in end()
      const chunk = asRecord(value);
      if (chunk === null) return out;

      const id = asString(chunk["id"]);
      if (id !== undefined) messageId = id;
      ensureStart(out);

      const choice = asRecord((asArray(chunk["choices"]) ?? [])[0]);
      if (choice !== null) {
        const delta = asRecord(choice["delta"]) ?? {};
        const text = asString(delta["content"]);
        if (text !== undefined && text !== "") {
          if (!textOpen) {
            textOpen = true;
            textIndex = nextIndex++;
            out.push(sse("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } }));
          }
          out.push(sse("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } }));
        }
        const toolCalls = asArray(delta["tool_calls"]);
        if (toolCalls !== null) {
          for (const tc of toolCalls) {
            const c = asRecord(tc);
            if (c === null) continue;
            const oaIndex = asNumber(c["index"]) ?? 0;
            const fn = asRecord(c["function"]) ?? {};
            let aiIndex = toolByOpenAIIndex.get(oaIndex);
            if (aiIndex === undefined) {
              aiIndex = nextIndex++;
              toolByOpenAIIndex.set(oaIndex, aiIndex);
              out.push(sse("content_block_start", { index: aiIndex, content_block: { type: "tool_use", id: asString(c["id"]) ?? `call_${aiIndex}`, name: asString(fn["name"]) ?? "", input: {} } }));
            }
            const args = asString(fn["arguments"]);
            if (args !== undefined && args !== "") out.push(sse("content_block_delta", { index: aiIndex, delta: { type: "input_json_delta", partial_json: args } }));
          }
        }
        const fr = asString(choice["finish_reason"]);
        if (fr !== undefined && fr !== "" && fr !== "null") stopReason = mapFinishReason(fr);
      }

      const u = asRecord(chunk["usage"]);
      if (u !== null) usage = { input_tokens: asNumber(u["prompt_tokens"]) ?? 0, output_tokens: asNumber(u["completion_tokens"]) ?? 0 };

      return out;
    },

    end(): string[] {
      if (ended) return [];
      ended = true;
      const out: string[] = [];
      ensureStart(out); // a zero-chunk stream still emits a well-formed (empty) message
      if (textOpen) out.push(sse("content_block_stop", { index: textIndex }));
      for (const aiIndex of toolByOpenAIIndex.values()) out.push(sse("content_block_stop", { index: aiIndex }));
      out.push(sse("message_delta", { delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null }, usage: usage ?? { output_tokens: 0 } }));
      out.push(sse("message_stop", {}));
      return out;
    },
  };
}
