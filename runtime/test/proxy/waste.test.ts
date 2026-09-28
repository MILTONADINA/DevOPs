// Unit tests for src/proxy/waste.ts — Phase 1 waste-detection heuristics over
// synthetic captured sessions. Pure; no I/O.

import { describe, test, expect } from "vitest";
import {
  detectSystemRepetition,
  detectToolRepetition,
  detectContextTax,
  detectDuplicateContent,
  runWasteDetectors,
} from "../../src/proxy/waste";
import type { CaptureSession, CapturedTurn } from "../../src/proxy/capture";

function turn(over: Partial<CapturedTurn> & { input?: number } = {}): CapturedTurn {
  return {
    turn: 1,
    timestamp: 0,
    request: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 64, ...(over.request ?? {}) },
    token_counts: { input_tokens: over.input ?? 100, token_count_method: "exact", message_breakdown: [] },
    response: {},
    elapsed_ms: 1,
  };
}

function session(turns: CapturedTurn[]): CaptureSession {
  return {
    session_id: "s",
    started_at: "t",
    total_turns: turns.length,
    total_input_tokens: 0,
    total_output_tokens: 0,
    dropped_turns: 0,
    requests: turns,
  };
}

describe("detectSystemRepetition", () => {
  test("identical system prompt across turns is flagged", () => {
    const sys = "You are a helpful assistant. ".repeat(40); // ~1160 chars
    const s = session([
      turn({ request: { model: "m", messages: [], system: sys, max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [], system: sys, max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [], system: sys, max_tokens: 8 } }),
    ]);
    const f = detectSystemRepetition(s);
    expect(f).toHaveLength(1);
    expect(f[0]!.type).toBe("system_prompt_repetition");
    expect(f[0]!.token_estimate).toBeGreaterThan(0); // (3-1) × ~290 tok
  });

  test("no system / single turn → no finding", () => {
    expect(detectSystemRepetition(session([turn(), turn()]))).toHaveLength(0);
  });

  test("differing system prompts → not flagged as repetition", () => {
    const s = session([
      turn({ request: { model: "m", messages: [], system: "A", max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [], system: "B", max_tokens: 8 } }),
    ]);
    expect(detectSystemRepetition(s)).toHaveLength(0);
  });
});

describe("detectToolRepetition", () => {
  test("identical tools[] across turns is flagged", () => {
    const tools = [{ name: "get_weather", description: "x".repeat(500), input_schema: {} }];
    const s = session([
      turn({ request: { model: "m", messages: [], tools, max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [], tools, max_tokens: 8 } }),
    ]);
    const f = detectToolRepetition(s);
    expect(f).toHaveLength(1);
    expect(f[0]!.type).toBe("tool_definitions_repetition");
  });
});

describe("detectContextTax", () => {
  test("monotonic input growth → re-sent overhead = total − peak", () => {
    const s = session([turn({ input: 100 }), turn({ input: 250 }), turn({ input: 500 })]);
    const f = detectContextTax(s);
    expect(f).toHaveLength(1);
    expect(f[0]!.type).toBe("context_tax");
    expect(f[0]!.token_estimate).toBe(100 + 250 + 500 - 500); // total(850) − peak(500) = 350
    expect(f[0]!.description).toContain("monotonic growth");
  });

  test("single turn → no context tax", () => {
    expect(detectContextTax(session([turn({ input: 100 })]))).toHaveLength(0);
  });
});

describe("detectDuplicateContent", () => {
  test("large content block repeated across turns is flagged", () => {
    const paste = "BIG PASTE ".repeat(40); // ~400 chars, ≥200
    const s = session([
      turn({ request: { model: "m", messages: [{ role: "user", content: paste }], max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [{ role: "user", content: paste }], max_tokens: 8 } }),
    ]);
    const f = detectDuplicateContent(s);
    expect(f).toHaveLength(1);
    expect(f[0]!.type).toBe("duplicate_message_content");
    expect(f[0]!.token_estimate).toBeGreaterThan(0);
  });

  test("short repeated content is ignored (<200 chars)", () => {
    const s = session([
      turn({ request: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 } }),
      turn({ request: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8 } }),
    ]);
    expect(detectDuplicateContent(s)).toHaveLength(0);
  });
});

describe("runWasteDetectors", () => {
  test("aggregates + sorts findings by token_estimate desc", () => {
    const sys = "S".repeat(8000); // big system → high
    const s = session([
      turn({ input: 200, request: { model: "m", messages: [], system: sys, max_tokens: 8 } }),
      turn({ input: 400, request: { model: "m", messages: [], system: sys, max_tokens: 8 } }),
    ]);
    const findings = runWasteDetectors(s);
    expect(findings.length).toBeGreaterThanOrEqual(2); // system_repetition + context_tax
    // sorted descending
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1]!.token_estimate).toBeGreaterThanOrEqual(findings[i]!.token_estimate);
    }
  });
});
