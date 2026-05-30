/**
 * Anthropic ⇄ Google Gemini translation (ADR-0019) — PURE, no I/O, unit-tested.
 *
 * Gemini's `generateContent` API differs from both Anthropic and OpenAI: messages are `contents` with
 * `parts`, the assistant role is `model`, the system prompt is `systemInstruction`, tools are
 * `functionDeclarations`, and tool results are `functionResponse` parts keyed by the function NAME (not an
 * id). This module translates an Anthropic-shaped request OUT to Gemini and the response/stream BACK to the
 * Anthropic shape (a Message object + Anthropic SSE).
 */

import type { MessagesBody } from "../forward";
import type { AnthropicMessage } from "./translate-openai";

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

/* ----------------------------------- request: Anthropic → Gemini ----------------------------------- */

/**
 * Translate an Anthropic-shaped request into a Gemini generateContent request body.
 *
 * @param body - the inbound Anthropic-shaped request (may carry extra fields like temperature).
 * @returns the Gemini request body.
 */
export function anthropicToGeminiRequest(body: MessagesBody): Record<string, unknown> {
  const raw = body as unknown as Record<string, unknown>;
  const contents: Record<string, unknown>[] = [];
  // Gemini's functionResponse needs the function NAME, but an Anthropic tool_result only carries the
  // tool_use_id. Build id→name from the assistant tool_use blocks (present in the echoed history) so a
  // later tool_result can recover the name.
  const idToName = new Map<string, string>();

  for (const msg of body.messages ?? []) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [];
    const content = msg.content;

    if (typeof content === "string") {
      if (content !== "") parts.push({ text: content });
    } else {
      const blocks = asArray(content) ?? [];
      for (const b of blocks) {
        const blk = asRecord(b);
        if (blk === null) continue;
        const t = asString(blk["type"]);
        if (t === "text") {
          const text = asString(blk["text"]);
          if (text !== undefined) parts.push({ text });
        } else if (t === "image") {
          const src = asRecord(blk["source"]);
          const data = src ? asString(src["data"]) : undefined;
          if (src && src["type"] === "base64" && data !== undefined) parts.push({ inlineData: { mimeType: asString(src["media_type"]) ?? "image/png", data } });
        } else if (t === "tool_use") {
          const id = asString(blk["id"]) ?? "";
          const name = asString(blk["name"]) ?? "";
          if (id !== "") idToName.set(id, name);
          parts.push({ functionCall: { name, args: blk["input"] ?? {} } });
        } else if (t === "tool_result") {
          const id = asString(blk["tool_use_id"]) ?? "";
          const name = idToName.get(id) ?? id;
          const rc = blk["content"];
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
          parts.push({ functionResponse: { name, response: { result: text } } });
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  const out: Record<string, unknown> = { contents };

  const sys = flattenSystem(body.system);
  if (sys !== "") out["systemInstruction"] = { parts: [{ text: sys }] };

  const tools = asArray(body.tools);
  if (tools !== null && tools.length > 0) {
    out["tools"] = [
      {
        functionDeclarations: tools
          .map((t) => {
            const r = asRecord(t);
            return r === null ? null : { name: asString(r["name"]) ?? "", description: asString(r["description"]) ?? "", parameters: r["input_schema"] ?? { type: "object" } };
          })
          .filter((x) => x !== null),
      },
    ];
  }

  const generationConfig: Record<string, unknown> = { maxOutputTokens: body.max_tokens };
  const temperature = asNumber(raw["temperature"]);
  if (temperature !== undefined) generationConfig["temperature"] = temperature;
  const topP = asNumber(raw["top_p"]);
  if (topP !== undefined) generationConfig["topP"] = topP;
  const stops = asArray(raw["stop_sequences"]);
  if (stops !== null && stops.length > 0) generationConfig["stopSequences"] = stops.filter((s) => typeof s === "string");
  out["generationConfig"] = generationConfig;

  return out;
}

/* ----------------------------------- response: Gemini → Anthropic ----------------------------------- */

/** Map a Gemini finishReason to an Anthropic stop_reason. */
export function mapGeminiFinish(reason: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall) return "tool_use";
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "STOP":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** Convert a single Gemini `content.parts` array into Anthropic content blocks + whether a tool call appeared. */
function partsToAnthropic(parts: unknown[], toolSeq: { n: number }): { blocks: Record<string, unknown>[]; sawTool: boolean } {
  const blocks: Record<string, unknown>[] = [];
  let sawTool = false;
  for (const p of parts) {
    const part = asRecord(p);
    if (part === null) continue;
    const text = asString(part["text"]);
    if (text !== undefined) {
      blocks.push({ type: "text", text });
      continue;
    }
    const fc = asRecord(part["functionCall"]);
    if (fc !== null) {
      sawTool = true;
      blocks.push({ type: "tool_use", id: `gemini_tool_${toolSeq.n++}`, name: asString(fc["name"]) ?? "", input: fc["args"] ?? {} });
    }
  }
  return { blocks, sawTool };
}

/**
 * Translate a Gemini generateContent response into an Anthropic Message.
 *
 * @param model - the model id to report.
 * @param resp - the parsed Gemini response object.
 * @returns an Anthropic-shaped Message.
 */
export function geminiResponseToAnthropic(model: string, resp: unknown): AnthropicMessage {
  const r = asRecord(resp) ?? {};
  const candidates = asArray(r["candidates"]) ?? [];
  const cand = asRecord(candidates[0]) ?? {};
  const content = asRecord(cand["content"]) ?? {};
  const parts = asArray(content["parts"]) ?? [];
  const usage = asRecord(r["usageMetadata"]) ?? {};

  const { blocks, sawTool } = partsToAnthropic(parts, { n: 0 });
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });

  return {
    id: asString(r["responseId"]) ?? "msg_gemini",
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: mapGeminiFinish(asString(cand["finishReason"]), sawTool),
    stop_sequence: null,
    usage: { input_tokens: asNumber(usage["promptTokenCount"]) ?? 0, output_tokens: asNumber(usage["candidatesTokenCount"]) ?? 0 },
  };
}

/* ----------------------------------- streaming: Gemini SSE → Anthropic SSE ----------------------------------- */

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export interface GeminiStreamTranslator {
  push(value: unknown): string[];
  end(): string[];
}

/**
 * Create a stateful translator from Gemini streamed chunks (streamGenerateContent?alt=sse) to Anthropic
 * SSE events. Gemini streams text incrementally and emits usageMetadata (and finishReason) on the final
 * chunk; tool calls arrive as whole functionCall parts. Emits the canonical Anthropic event sequence with
 * the exact upstream usage in message_delta (input + output).
 *
 * @param model - the model id to report in message_start.
 * @returns a {@link GeminiStreamTranslator}.
 */
export function createGeminiStreamTranslator(model: string): GeminiStreamTranslator {
  let started = false;
  let ended = false;
  let textOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  let toolSeq = 0;
  let stopReason: string | undefined;
  let sawTool = false;
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  function ensureStart(out: string[]): void {
    if (started) return;
    started = true;
    out.push(
      sse("message_start", {
        message: { id: "msg_gemini", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      }),
    );
  }

  return {
    push(value: unknown): string[] {
      const out: string[] = [];
      const chunk = asRecord(value);
      if (chunk === null) return out;
      ensureStart(out);

      const cand = asRecord((asArray(chunk["candidates"]) ?? [])[0]);
      if (cand !== null) {
        const content = asRecord(cand["content"]);
        const parts = content ? (asArray(content["parts"]) ?? []) : [];
        for (const p of parts) {
          const part = asRecord(p);
          if (part === null) continue;
          const text = asString(part["text"]);
          if (text !== undefined && text !== "") {
            if (!textOpen) {
              textOpen = true;
              textIndex = nextIndex++;
              out.push(sse("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } }));
            }
            out.push(sse("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } }));
            continue;
          }
          const fc = asRecord(part["functionCall"]);
          if (fc !== null) {
            sawTool = true;
            const idx = nextIndex++;
            out.push(sse("content_block_start", { index: idx, content_block: { type: "tool_use", id: `gemini_tool_${toolSeq++}`, name: asString(fc["name"]) ?? "", input: {} } }));
            out.push(sse("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(fc["args"] ?? {}) } }));
            out.push(sse("content_block_stop", { index: idx }));
          }
        }
        const fr = asString(cand["finishReason"]);
        if (fr !== undefined && fr !== "") stopReason = mapGeminiFinish(fr, sawTool);
      }

      const u = asRecord(chunk["usageMetadata"]);
      if (u !== null) usage = { input_tokens: asNumber(u["promptTokenCount"]) ?? 0, output_tokens: asNumber(u["candidatesTokenCount"]) ?? 0 };

      return out;
    },

    end(): string[] {
      if (ended) return [];
      ended = true;
      const out: string[] = [];
      ensureStart(out);
      if (textOpen) out.push(sse("content_block_stop", { index: textIndex }));
      out.push(sse("message_delta", { delta: { stop_reason: stopReason ?? (sawTool ? "tool_use" : "end_turn"), stop_sequence: null }, usage: usage ?? { output_tokens: 0 } }));
      out.push(sse("message_stop", {}));
      return out;
    },
  };
}
