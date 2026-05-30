// Tests for the Anthropic <-> OpenAI translation (ADR-0019): request out, response back, and a full
// streaming round-trip (OpenAI chunks -> Anthropic SSE -> the real accumulator reconstructs the message).

import { describe, test, expect } from "vitest";
import { anthropicToOpenAIRequest, openAIResponseToAnthropic, mapFinishReason, createOpenAIStreamTranslator } from "../../src/proxy/providers/translate-openai";
import { createSseParser, accumulateAnthropicStream } from "../../src/proxy/sse";
import type { MessagesBody } from "../../src/proxy/forward";

describe("anthropicToOpenAIRequest", () => {
  test("flattens system, maps a string message, sets max_tokens + stream_options", () => {
    const body: MessagesBody = { model: "gpt-4o", system: "be terse", messages: [{ role: "user", content: "hello" }], max_tokens: 256 };
    const req = anthropicToOpenAIRequest("gpt-4o", body, true) as Record<string, unknown>;
    expect(req["model"]).toBe("gpt-4o");
    expect(req["max_tokens"]).toBe(256);
    expect(req["stream"]).toBe(true);
    expect(req["stream_options"]).toEqual({ include_usage: true });
    const msgs = req["messages"] as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(msgs[1]).toEqual({ role: "user", content: "hello" });
  });

  test("reasoning models use max_completion_tokens and drop temperature", () => {
    const body = { model: "o1", messages: [{ role: "user", content: "x" }], max_tokens: 100, temperature: 0.7 } as unknown as MessagesBody;
    const req = anthropicToOpenAIRequest("o1", body, false) as Record<string, unknown>;
    expect(req["max_completion_tokens"]).toBe(100);
    expect(req["max_tokens"]).toBeUndefined();
    expect(req["temperature"]).toBeUndefined();
  });

  test("passes temperature/top_p and maps stop_sequences -> stop for non-reasoning models", () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "x" }], max_tokens: 50, temperature: 0.3, top_p: 0.9, stop_sequences: ["STOP"] } as unknown as MessagesBody;
    const req = anthropicToOpenAIRequest("gpt-4o", body, false) as Record<string, unknown>;
    expect(req["temperature"]).toBe(0.3);
    expect(req["top_p"]).toBe(0.9);
    expect(req["stop"]).toEqual(["STOP"]);
  });

  test("text + image blocks -> OpenAI content parts (base64 -> data URL)", () => {
    const body: MessagesBody = {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] }],
      max_tokens: 64,
    };
    const req = anthropicToOpenAIRequest("gpt-4o", body, false) as Record<string, unknown>;
    const parts = (req["messages"] as Record<string, unknown>[])[0]!["content"] as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "what is this" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
  });

  test("assistant tool_use -> tool_calls; user tool_result -> role:tool message; tools translated", () => {
    const body: MessagesBody = {
      model: "gpt-4o",
      max_tokens: 64,
      tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      messages: [
        { role: "user", content: "weather in NYC?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }] },
      ],
    };
    const req = anthropicToOpenAIRequest("gpt-4o", body, false) as Record<string, unknown>;
    const msgs = req["messages"] as Record<string, unknown>[];
    // assistant tool_calls
    const assistant = msgs.find((m) => m["role"] === "assistant")!;
    const calls = assistant["tool_calls"] as Record<string, unknown>[];
    expect(calls[0]).toMatchObject({ id: "call_1", type: "function" });
    expect((calls[0]!["function"] as Record<string, unknown>)["arguments"]).toBe(JSON.stringify({ city: "NYC" }));
    // tool result message
    const toolMsg = msgs.find((m) => m["role"] === "tool")!;
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "call_1", content: "72F" });
    // tools definition
    const tools = req["tools"] as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: "function", function: { name: "get_weather", description: "weather" } });
    expect((tools[0]!["function"] as Record<string, unknown>)["parameters"]).toEqual({ type: "object", properties: { city: { type: "string" } } });
  });
});

describe("openAIResponseToAnthropic", () => {
  test("text response -> Anthropic message with usage + stop_reason", () => {
    const resp = { id: "chatcmpl-1", model: "gpt-4o", choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
    const msg = openAIResponseToAnthropic("gpt-4o", resp);
    expect(msg).toMatchObject({ id: "chatcmpl-1", type: "message", role: "assistant", model: "gpt-4o", stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } });
    expect(msg.content).toEqual([{ type: "text", text: "Hi there" }]);
  });

  test("tool_calls response -> tool_use blocks (arguments parsed), stop_reason tool_use", () => {
    const resp = { id: "c2", model: "gpt-4o", choices: [{ message: { tool_calls: [{ id: "call_9", function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    const msg = openAIResponseToAnthropic("gpt-4o", resp);
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0]).toEqual({ type: "tool_use", id: "call_9", name: "f", input: { a: 1 } });
  });

  test("mapFinishReason covers length/tool_calls/stop/unknown", () => {
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason("content_filter")).toBe("end_turn");
    expect(mapFinishReason(undefined)).toBe("end_turn");
  });
});

describe("createOpenAIStreamTranslator — streaming round-trip through the real accumulator", () => {
  /** Feed OpenAI chunks through the translator, then parse the emitted Anthropic SSE with the real accumulator. */
  function roundTrip(chunks: unknown[]): ReturnType<typeof accumulateAnthropicStream> {
    const tr = createOpenAIStreamTranslator("gpt-4o");
    let sse = "";
    for (const c of chunks) sse += tr.push(c).join("");
    sse += tr.end().join("");
    const parser = createSseParser();
    return accumulateAnthropicStream(parser.push(sse));
  }

  test("text deltas reconstruct the full message + EXACT upstream usage (input + output)", () => {
    const r = roundTrip([
      { id: "chatcmpl-z", choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: ", world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } },
    ]);
    expect(r.message.id).toBe("chatcmpl-z");
    expect(r.message.content[0]).toMatchObject({ type: "text", text: "Hello, world" });
    expect(r.message.stop_reason).toBe("end_turn");
    // input_tokens flows from message_delta (the accumulator merges it) — exact upstream count, not an estimate.
    expect(r.message.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
  });

  test("streamed tool_call deltas reconstruct a tool_use block with accumulated arguments", () => {
    const r = roundTrip([
      { id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_5", function: { name: "lookup", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 9 } },
    ]);
    expect(r.message.stop_reason).toBe("tool_use");
    const block = r.message.content[0] as Record<string, unknown>;
    expect(block["type"]).toBe("tool_use");
    expect(block["id"]).toBe("call_5");
    expect(block["name"]).toBe("lookup");
    expect(block["partial_json"]).toBe('{"q":"hi"}'); // accumulated input_json_delta
    expect(r.message.usage).toEqual({ input_tokens: 7, output_tokens: 9 });
  });

  test("a zero-chunk stream still emits a well-formed (empty) Anthropic message", () => {
    const r = roundTrip([]);
    expect(r.message.role).toBe("assistant");
    expect(r.message.stop_reason).toBe("end_turn");
  });
});
