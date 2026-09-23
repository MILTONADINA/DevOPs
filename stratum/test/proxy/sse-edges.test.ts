// Additional SSE parser/accumulator edge-case coverage (§2d hardening) — hits
// the defensive branches that a hostile/odd upstream stream can produce.

import { describe, test, expect } from "vitest";
import { createSseParser, accumulateAnthropicStream, type SseEvent } from "../../src/proxy/sse";

function parseAll(raw: string): SseEvent[] {
  const p = createSseParser();
  return [...p.push(raw), ...p.flush()];
}

describe("SSE parser — edge branches", () => {
  test("event field with no data line → {event, data:null}", () => {
    const ev = parseAll("event: ping\n\n");
    expect(ev).toEqual([{ event: "ping", data: null }]);
  });

  test("data line with no event field → {data}", () => {
    const ev = parseAll('data: {"type":"message_stop"}\n\n');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event).toBeUndefined();
    expect((ev[0]!.data as { type: string }).type).toBe("message_stop");
  });

  test("comment-only + blank blocks produce no events", () => {
    expect(parseAll(": just a comment\n\n\n\n")).toEqual([]);
  });

  test("flush drains a trailing event that lacks the final blank line", () => {
    const p = createSseParser();
    expect(p.push("event: message_stop\ndata: {}")).toEqual([]); // not yet terminated
    const flushed = p.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.event).toBe("message_stop");
  });

  test("multi-line data lines are joined", () => {
    const ev = parseAll('data: line1\ndata: line2\n\n');
    expect(ev[0]!.data).toBe("line1\nline2");
  });
});

describe("accumulateAnthropicStream — defensive branches", () => {
  test("content_block_delta to an absent index creates a default text block", () => {
    const ev = parseAll(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    );
    const { message } = accumulateAnthropicStream(ev);
    expect(message.content[2]!.type).toBe("text");
    expect(message.content[2]!.text).toBe("hi");
  });

  test("unknown delta type is ignored (no throw, no text)", () => {
    const ev = parseAll(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"citation_delta","x":1}}\n\n',
    );
    const { message } = accumulateAnthropicStream(ev);
    expect(message.content[0]!.text).toBeUndefined();
  });

  test("message_delta without usage keeps prior usage; stop_reason set", () => {
    const ev = parseAll(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
    );
    const { message } = accumulateAnthropicStream(ev);
    expect(message.stop_reason).toBe("max_tokens");
    expect(message.usage?.input_tokens).toBe(7); // preserved
  });

  test("message_start without a message field is a no-op", () => {
    const ev = parseAll('event: message_start\ndata: {"type":"message_start"}\n\n');
    const { message } = accumulateAnthropicStream(ev);
    expect(message.id).toBeUndefined();
    expect(message.content).toEqual([]);
  });

  test("content_block_start without index is ignored", () => {
    const ev = parseAll('event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}\n\n');
    const { message } = accumulateAnthropicStream(ev);
    expect(message.content).toEqual([]);
  });
});
