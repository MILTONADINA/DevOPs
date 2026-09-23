// Unit tests for the Claude Code transcript → capture-turn converter. Pure
// function over synthetic JSONL lines (no fs, no real transcript).

import { describe, test, expect } from "vitest";
import { convertTranscript } from "../../scripts/import-sessions";

const rec = (o: unknown): string => JSON.stringify(o);

describe("convertTranscript", () => {
  test("pairs each assistant turn with its preceding user input + exact usage", () => {
    const lines = [
      rec({ type: "user", sessionId: "s1", timestamp: "2026-05-23T09:38:40.000Z", message: { role: "user", content: "fix the bug" } }),
      rec({
        type: "assistant",
        timestamp: "2026-05-23T09:38:45.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          id: "msg_1",
          stop_reason: "end_turn",
          usage: { input_tokens: 6, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 971 },
          content: [{ type: "text", text: "done" }],
        },
      }),
    ];
    const { sessionId, turns, assistantRecords } = convertTranscript(lines);
    expect(sessionId).toBe("s1");
    expect(assistantRecords).toBe(1);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.request.model).toBe("claude-opus-4-7");
    expect(t.request.messages).toBe("fix the bug");
    // true processed context = reported input + cache_read + cache_creation
    expect(t.inputTokens).toBe(6 + 1000 + 200);
    expect(t.tokenCountMethod).toBe("exact");
    // response.usage carries the API-reported (non-cache) input + output
    expect(t.response).toMatchObject({ id: "msg_1", stop_reason: "end_turn", usage: { input_tokens: 6, output_tokens: 971 } });
    // elapsed = assistant ts − preceding user ts = 5s
    expect(t.elapsedMs).toBe(5000);
  });

  test("skips non-API records (attachment/system/permission-mode) + malformed lines", () => {
    const lines = [
      rec({ type: "attachment", sessionId: "s2" }),
      "{ this is not json",
      rec({ type: "permission-mode", permissionMode: "default" }),
      rec({ type: "user", message: { role: "user", content: "hi" } }),
      rec({ type: "assistant", message: { role: "assistant", model: "m", usage: { input_tokens: 10, output_tokens: 20 } } }),
    ];
    const { turns, assistantRecords, skippedLines } = convertTranscript(lines);
    expect(assistantRecords).toBe(1);
    expect(turns).toHaveLength(1);
    expect(skippedLines).toBe(1); // the malformed line
    expect(turns[0]!.inputTokens).toBe(10); // no cache fields → just reported input
  });

  test("missing usage fields default to 0 (no NaN)", () => {
    const lines = [
      rec({ type: "user", message: { content: "q" } }),
      rec({ type: "assistant", message: { model: "m" } }), // no usage at all
    ];
    const { turns } = convertTranscript(lines);
    expect(turns[0]!.inputTokens).toBe(0);
    expect(turns[0]!.response).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 } });
    expect(turns[0]!.elapsedMs).toBe(0); // no timestamps
  });

  test("empty / assistant-free transcript yields no turns", () => {
    expect(convertTranscript([]).turns).toEqual([]);
    expect(convertTranscript([rec({ type: "user", message: { content: "x" } })]).turns).toEqual([]);
  });

  test("dedups multiple records sharing a message.id (one logical response → one turn, counted once)", () => {
    // Claude Code emits one API response as many records (per content block),
    // all repeating the SAME id + usage. Counting each inflated totals ~3x.
    const usage = { input_tokens: 6, cache_read_input_tokens: 1000, output_tokens: 971 };
    const lines = [
      rec({ type: "user", message: { content: "q" } }),
      rec({ type: "assistant", message: { id: "msg_1", model: "m", usage, content: [{ type: "thinking" }] } }),
      rec({ type: "assistant", message: { id: "msg_1", model: "m", usage, content: [{ type: "text" }] } }),
      rec({ type: "assistant", message: { id: "msg_1", model: "m", usage, content: [{ type: "tool_use" }] } }),
      rec({ type: "assistant", message: { id: "msg_2", model: "m", usage: { input_tokens: 5, output_tokens: 7 } } }),
    ];
    const { turns, assistantRecords } = convertTranscript(lines);
    expect(assistantRecords).toBe(4); // raw record count (informational)
    expect(turns).toHaveLength(2); // ONE turn per unique message.id
    expect(turns[0]!.inputTokens).toBe(1006); // counted ONCE (6 + 1000 cache), not 3x
    expect(turns[1]!.inputTokens).toBe(5);
  });

  test("records without an id are not deduped (treated as distinct)", () => {
    const lines = [
      rec({ type: "assistant", message: { model: "m", usage: { input_tokens: 3, output_tokens: 4 } } }),
      rec({ type: "assistant", message: { model: "m", usage: { input_tokens: 3, output_tokens: 4 } } }),
    ];
    expect(convertTranscript(lines).turns).toHaveLength(2);
  });
});
