// Unit tests for src/proxy/sse.ts — SSE incremental parsing + Anthropic stream
// accumulation. Pure; no I/O. Covers chunk-boundary splits, tool-use json
// deltas, ping/comment skipping, error events, and malformed-chunk resilience.

import { describe, test, expect } from "vitest";
import { createSseParser, accumulateAnthropicStream, type SseEvent } from "../../src/proxy/sse";

const TEXT_STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  ': ping comment',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join("\n");

function parseAll(raw: string): SseEvent[] {
  const p = createSseParser();
  return [...p.push(raw), ...p.flush()];
}

describe("createSseParser", () => {
  test("parses a full text stream into its events", () => {
    const events = parseAll(TEXT_STREAM);
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // ": ping comment" block has no data → dropped, not an event.
  });

  test("chunk-boundary split yields identical events (incremental parse)", () => {
    const whole = parseAll(TEXT_STREAM);

    // Feed the stream in tiny 5-char chunks across arbitrary boundaries.
    const p = createSseParser();
    const events: SseEvent[] = [];
    for (let i = 0; i < TEXT_STREAM.length; i += 5) {
      events.push(...p.push(TEXT_STREAM.slice(i, i + 5)));
    }
    events.push(...p.flush());

    expect(events.map((e) => e.event)).toEqual(whole.map((e) => e.event));
  });

  test("CRLF line endings are handled", () => {
    const crlf = TEXT_STREAM.replace(/\n/g, "\r\n");
    expect(parseAll(crlf).length).toBe(7);
  });

  test("malformed data JSON degrades to raw string (no throw)", () => {
    const raw = "event: weird\ndata: {not valid json\n\n";
    const events = parseAll(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("{not valid json");
  });
});

describe("accumulateAnthropicStream — text", () => {
  test("folds a text stream into the final message", () => {
    const { message, events, error } = accumulateAnthropicStream(parseAll(TEXT_STREAM));
    expect(error).toBeUndefined();
    expect(events).toBe(7);
    expect(message.id).toBe("msg_1");
    expect(message.role).toBe("assistant");
    expect(message.content[0]!.text).toBe("Hello world");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage?.input_tokens).toBe(10);
    expect(message.usage?.output_tokens).toBe(5);
  });
});

describe("accumulateAnthropicStream — tool use", () => {
  test("accumulates input_json_delta partial_json across deltas", () => {
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","role":"assistant","content":[]}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_weather"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join("\n\n");
    const { message } = accumulateAnthropicStream(parseAll(stream));
    expect(message.content[0]!.type).toBe("tool_use");
    expect(message.content[0]!.partial_json).toBe('{"city":"SF"}');
  });
});

describe("accumulateAnthropicStream — error + resilience", () => {
  test("error event surfaces in result.error", () => {
    const stream =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
    const { error } = accumulateAnthropicStream(parseAll(stream));
    expect((error as { type: string }).type).toBe("overloaded_error");
  });

  test("empty / unknown events do not throw and yield an empty message", () => {
    const { message, events } = accumulateAnthropicStream(parseAll("event: ping\ndata: {}\n\n"));
    expect(events).toBe(1);
    expect(message.content).toEqual([]);
  });
});
