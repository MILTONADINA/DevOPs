/**
 * Server-Sent Events parsing + Anthropic streaming accumulation (§2d P0-B).
 *
 * Two pure pieces, both heavily fixture-tested (no I/O):
 *   - createSseParser(): a stateful incremental parser. push(chunk) returns the
 *     complete SSE events decoded so far (handling chunk boundaries that split
 *     an event); flush() drains a trailing event with no terminating blank line.
 *   - accumulateAnthropicStream(events): folds an Anthropic message stream
 *     (message_start → content_block_* → message_delta → message_stop) into the
 *     final non-streaming message shape, so the proxy can capture the turn
 *     exactly as the non-streaming path would.
 *
 * Strict + no `any`: event data is treated as Record<string, unknown> and every
 * field is narrowed before use, so malformed chunks degrade gracefully instead
 * of throwing (a hostile/truncated stream must never crash the proxy).
 */

export interface SseEvent {
  /** The `event:` field, if present. */
  event?: string;
  /** Parsed `data:` JSON, or the raw string if it was not valid JSON, or null. */
  data: unknown;
}

function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) {
    return event !== undefined ? { event, data: null } : null;
  }
  const dataStr = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = dataStr; // malformed JSON → keep the raw string; caller decides
  }
  return event !== undefined ? { event, data } : { data };
}

export interface SseParser {
  push(chunk: string): SseEvent[];
  flush(): SseEvent[];
}

/** Create a stateful incremental SSE parser tolerant of split chunk boundaries. */
export function createSseParser(): SseParser {
  let buffer = "";
  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let idx: number;
      // Events are separated by a blank line (\n\n). Normalize CRLF first.
      buffer = buffer.replace(/\r\n/g, "\n");
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseBlock(block);
        if (ev) events.push(ev);
      }
      return events;
    },
    flush(): SseEvent[] {
      const rest = buffer.trim();
      buffer = "";
      if (!rest) return [];
      const ev = parseBlock(rest);
      return ev ? [ev] : [];
    },
  };
}

export interface AccumulatedContentBlock {
  type: string;
  text?: string;
  partial_json?: string;
  [k: string]: unknown;
}

export interface AccumulatedMessage {
  id?: string | undefined;
  type?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  content: AccumulatedContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: { input_tokens?: number | undefined; output_tokens?: number | undefined } | undefined;
}

export interface AccumulateResult {
  message: AccumulatedMessage;
  /** Number of events folded. */
  events: number;
  /** Set if an `error` event was seen in the stream. */
  error?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Fold an Anthropic SSE event sequence into the final message object.
 *
 * @param events - parsed SSE events in arrival order.
 * @returns the accumulated message + event count (+ error if an error event fired).
 */
export function accumulateAnthropicStream(events: SseEvent[]): AccumulateResult {
  const msg: AccumulatedMessage = { content: [] };
  let error: unknown;
  let count = 0;

  for (const ev of events) {
    count++;
    const d = asRecord(ev.data);
    const type = (d && asString(d["type"])) ?? ev.event;

    switch (type) {
      case "message_start": {
        const m = d ? asRecord(d["message"]) : null;
        if (m) {
          msg.id = asString(m["id"]);
          msg.type = asString(m["type"]);
          msg.role = asString(m["role"]);
          msg.model = asString(m["model"]);
          const u = asRecord(m["usage"]);
          if (u) msg.usage = { input_tokens: asNumber(u["input_tokens"]), output_tokens: asNumber(u["output_tokens"]) };
          msg.content = [];
        }
        break;
      }
      case "content_block_start": {
        const index = d ? asNumber(d["index"]) : undefined;
        if (index !== undefined) {
          const cb = (d && asRecord(d["content_block"])) ?? { type: "text" };
          msg.content[index] = { type: asString(cb["type"]) ?? "text", ...cb } as AccumulatedContentBlock;
        }
        break;
      }
      case "content_block_delta": {
        const index = d ? asNumber(d["index"]) : undefined;
        const delta = d ? asRecord(d["delta"]) : null;
        if (index !== undefined && delta) {
          const block = msg.content[index] ?? (msg.content[index] = { type: "text" });
          const dt = asString(delta["type"]);
          if (dt === "text_delta") {
            const t = asString(delta["text"]);
            if (t !== undefined) block.text = (block.text ?? "") + t;
          } else if (dt === "input_json_delta") {
            const pj = asString(delta["partial_json"]);
            if (pj !== undefined) block.partial_json = (block.partial_json ?? "") + pj;
          }
        }
        break;
      }
      case "message_delta": {
        const delta = d ? asRecord(d["delta"]) : null;
        if (delta) {
          if ("stop_reason" in delta) msg.stop_reason = (asString(delta["stop_reason"]) ?? null);
          if ("stop_sequence" in delta) msg.stop_sequence = (asString(delta["stop_sequence"]) ?? null);
        }
        const u = d ? asRecord(d["usage"]) : null;
        if (u) msg.usage = { ...msg.usage, ...(asNumber(u["output_tokens"]) !== undefined ? { output_tokens: asNumber(u["output_tokens"]) } : {}) };
        break;
      }
      case "error": {
        error = d ? (d["error"] ?? d) : ev.data;
        break;
      }
      // content_block_stop, message_stop, ping, unknown → no state change.
      default:
        break;
    }
  }

  return { message: msg, events: count, ...(error !== undefined ? { error } : {}) };
}
