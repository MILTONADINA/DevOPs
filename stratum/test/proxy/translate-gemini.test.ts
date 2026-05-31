// Tests for the Anthropic <-> Gemini translation (ADR-0019): request out, response back, and a streaming
// round-trip (Gemini chunks -> Anthropic SSE -> the real accumulator reconstructs the message).

import { describe, test, expect } from "vitest";
import { anthropicToGeminiRequest, geminiResponseToAnthropic, mapGeminiFinish, createGeminiStreamTranslator } from "../../src/proxy/providers/translate-gemini";
import { createSseParser, accumulateAnthropicStream } from "../../src/proxy/sse";
import type { MessagesBody } from "../../src/proxy/forward";

describe("anthropicToGeminiRequest", () => {
  test("system -> systemInstruction; roles map (assistant->model); generationConfig", () => {
    const body = { model: "gemini-2.5-pro", system: "be terse", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], max_tokens: 128, temperature: 0.5, top_p: 0.8, stop_sequences: ["END"] } as unknown as MessagesBody;
    const req = anthropicToGeminiRequest(body) as Record<string, unknown>;
    expect(req["systemInstruction"]).toEqual({ parts: [{ text: "be terse" }] });
    const contents = req["contents"] as Record<string, unknown>[];
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "yo" }] });
    expect(req["generationConfig"]).toEqual({ maxOutputTokens: 128, temperature: 0.5, topP: 0.8, stopSequences: ["END"] });
  });

  test("image -> inlineData; tools -> functionDeclarations", () => {
    const body: MessagesBody = {
      model: "gemini-2.5-pro",
      max_tokens: 64,
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }] }],
    };
    const req = anthropicToGeminiRequest(body) as Record<string, unknown>;
    const parts = (req["contents"] as Record<string, unknown>[])[0]!["parts"] as Record<string, unknown>[];
    expect(parts[0]).toEqual({ text: "see" });
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "QQ==" } });
    const tools = req["tools"] as Record<string, unknown>[];
    expect((tools[0]!["functionDeclarations"] as Record<string, unknown>[])[0]).toEqual({ name: "f", description: "d", parameters: { type: "object" } });
  });

  test("tool_use -> functionCall; tool_result -> functionResponse with the NAME recovered from the id", () => {
    const body: MessagesBody = {
      model: "gemini-2.5-pro",
      max_tokens: 64,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }] },
      ],
    };
    const contents = (anthropicToGeminiRequest(body) as Record<string, unknown>)["contents"] as Record<string, unknown>[];
    const modelParts = contents[1]!["parts"] as Record<string, unknown>[];
    expect(modelParts[0]).toEqual({ functionCall: { name: "get_weather", args: { city: "NYC" } } });
    const fnRespParts = contents[2]!["parts"] as Record<string, unknown>[];
    // The id (call_1) is mapped back to the function name (get_weather) — Gemini keys functionResponse by name.
    expect(fnRespParts[0]).toEqual({ functionResponse: { name: "get_weather", response: { result: "72F" } } });
  });
});

describe("geminiResponseToAnthropic", () => {
  test("text candidate -> Anthropic message with usageMetadata mapped", () => {
    const resp = { candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
    const msg = geminiResponseToAnthropic("gemini-2.5-pro", resp);
    expect(msg).toMatchObject({ type: "message", role: "assistant", model: "gemini-2.5-pro", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("functionCall candidate -> tool_use block, stop_reason tool_use", () => {
    const resp = { candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } };
    const msg = geminiResponseToAnthropic("gemini-2.5-pro", resp);
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[0]).toMatchObject({ type: "tool_use", name: "f", input: { a: 1 } });
  });

  test("mapGeminiFinish: MAX_TOKENS/STOP/tool override", () => {
    expect(mapGeminiFinish("MAX_TOKENS", false)).toBe("max_tokens");
    expect(mapGeminiFinish("STOP", false)).toBe("end_turn");
    expect(mapGeminiFinish("STOP", true)).toBe("tool_use"); // a tool call overrides
    expect(mapGeminiFinish(undefined, false)).toBe("end_turn");
  });
});

describe("createGeminiStreamTranslator — round-trip through the real accumulator", () => {
  function roundTrip(chunks: unknown[]): ReturnType<typeof accumulateAnthropicStream> {
    const tr = createGeminiStreamTranslator("gemini-2.5-pro");
    let sse = "";
    for (const c of chunks) sse += tr.push(c).join("");
    sse += tr.end().join("");
    return accumulateAnthropicStream(createSseParser().push(sse));
  }

  test("text deltas reconstruct the message + exact usage", () => {
    const r = roundTrip([
      { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
      { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2 } },
    ]);
    expect(r.message.content[0]).toMatchObject({ type: "text", text: "Hello" });
    expect(r.message.stop_reason).toBe("end_turn");
    expect(r.message.usage).toEqual({ input_tokens: 11, output_tokens: 2 });
  });

  test("a streamed functionCall reconstructs a tool_use block; stop_reason tool_use", () => {
    const r = roundTrip([
      { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "hi" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } },
    ]);
    expect(r.message.stop_reason).toBe("tool_use");
    const block = r.message.content[0] as Record<string, unknown>;
    expect(block["type"]).toBe("tool_use");
    expect(block["name"]).toBe("lookup");
    expect(block["partial_json"]).toBe('{"q":"hi"}');
    expect(r.message.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
  });

  function blocksWellFormed(sse: string): boolean {
    let open: number | null = null;
    for (const ev of createSseParser().push(sse)) {
      const d = ev.data as Record<string, unknown> | null;
      const type = d && typeof d["type"] === "string" ? (d["type"] as string) : ev.event;
      if (type === "content_block_start") {
        if (open !== null) return false;
        open = d ? (d["index"] as number) : null;
      } else if (type === "content_block_stop") {
        if (open === null || (d && d["index"] !== open)) return false;
        open = null;
      }
    }
    return open === null;
  }

  test("text then functionCall: the text block is closed before the tool block (non-overlapping)", () => {
    const tr = createGeminiStreamTranslator("gemini-2.5-pro");
    let sse = "";
    for (const c of [
      { candidates: [{ content: { parts: [{ text: "I will call the tool." }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8 } },
    ]) sse += tr.push(c).join("");
    sse += tr.end().join("");
    expect(blocksWellFormed(sse)).toBe(true); // would FAIL pre-fix (text block left open when the tool block opened)
    const r = accumulateAnthropicStream(createSseParser().push(sse));
    expect(r.message.content[0]).toMatchObject({ type: "text", text: "I will call the tool." });
    expect(r.message.content[1]).toMatchObject({ type: "tool_use", name: "lookup" });
    expect(r.message.stop_reason).toBe("tool_use");
  });
});

describe("anthropicToGeminiRequest + mapGeminiFinish — audit fixes", () => {
  test("user turn mixing tool_result + text → TWO separate Gemini contents (functionResponse isolated)", () => {
    const body = {
      model: "gemini-2.5-pro",
      max_tokens: 64,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "42" }, { type: "text", text: "now explain" }] },
      ],
    } as unknown as MessagesBody;
    const contents = (anthropicToGeminiRequest(body) as Record<string, unknown>)["contents"] as Record<string, unknown>[];
    const userEntries = contents.filter((c) => c["role"] === "user");
    expect(userEntries).toHaveLength(2); // functionResponse and text are NOT mixed in one content (Gemini 400)
    const fnEntry = userEntries.find((c) => "functionResponse" in (c["parts"] as Record<string, unknown>[])[0]!)!;
    expect(fnEntry).toBeDefined();
    expect((fnEntry["parts"] as Record<string, unknown>[]).every((p) => "functionResponse" in p)).toBe(true); // functionResponse entry is pure
  });

  test("URL-sourced image → Gemini fileData (not silently dropped)", () => {
    const body: MessagesBody = { model: "gemini-2.5-pro", max_tokens: 64, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png", media_type: "image/png" } }] }] };
    const parts = ((anthropicToGeminiRequest(body) as Record<string, unknown>)["contents"] as Record<string, unknown>[])[0]!["parts"] as Record<string, unknown>[];
    expect(parts[0]).toEqual({ fileData: { fileUri: "https://x/y.png", mimeType: "image/png" } });
  });

  test("multi-block system prompt joins with a blank line", () => {
    const body = { model: "gemini-2.5-pro", max_tokens: 16, system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], messages: [{ role: "user", content: "x" }] } as unknown as MessagesBody;
    expect((anthropicToGeminiRequest(body) as Record<string, unknown>)["systemInstruction"]).toEqual({ parts: [{ text: "A\n\nB" }] });
  });

  test("mapGeminiFinish does NOT mask a SAFETY/RECITATION stop as tool_use, even if a tool call was emitted", () => {
    expect(mapGeminiFinish("SAFETY", true)).toBe("end_turn");
    expect(mapGeminiFinish("RECITATION", true)).toBe("end_turn");
    expect(mapGeminiFinish("STOP", true)).toBe("tool_use"); // a normal stop with a tool call is genuine tool_use
    expect(mapGeminiFinish(undefined, true)).toBe("tool_use"); // no finishReason but a tool block was emitted
  });
});
