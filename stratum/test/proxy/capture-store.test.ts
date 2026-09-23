// Unit tests for src/proxy/capture.ts — the Phase 1 capture store.
//
// Covers: redaction-before-write, FAIL-CLOSED drop on redactor throw (no
// unredacted content reaches the fake fs), token accounting, dropped-turn
// accounting, token_count_method honesty, and end()/flush behavior. Uses an
// injected fake fs + clock so no real disk/time is touched.

import { describe, test, expect, vi } from "vitest";
import { createCaptureStore, type RecordTurnInput } from "../../src/proxy/capture";

function fakeFs() {
  const writes: { path: string; data: string }[] = [];
  return {
    writes,
    writeFileSync: (path: string, data: string) => {
      writes.push({ path, data });
    },
  };
}

function turn(overrides: Partial<RecordTurnInput> = {}): RecordTurnInput {
  return {
    request: {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 64,
    },
    response: {
      id: "msg_1",
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    },
    inputTokens: 10,
    tokenCountMethod: "exact",
    messageBreakdown: [{ role: "user", token_count: 10 }],
    elapsedMs: 12,
    ...overrides,
  };
}

describe("capture store — happy path", () => {
  test("records a turn, redacts, flushes to fs, updates totals", () => {
    const fs = fakeFs();
    const store = createCaptureStore({
      sessionId: "s1",
      outputFile: "/tmp/s1.json",
      fs,
      now: () => "2026-05-29T00:00:00.000Z",
    });

    const ok = store.record(turn());
    expect(ok).toBe(true);

    const s = store.getSession();
    expect(s.total_turns).toBe(1);
    expect(s.dropped_turns).toBe(0);
    expect(s.requests).toHaveLength(1);
    expect(s.total_input_tokens).toBe(10);
    expect(s.total_output_tokens).toBe(5);
    expect(s.requests[0]!.token_counts.token_count_method).toBe("exact");

    // Flushed to the (fake) fs at the right path.
    expect(fs.writes.length).toBeGreaterThan(0);
    expect(fs.writes.at(-1)!.path).toBe("/tmp/s1.json");
    expect(JSON.parse(fs.writes.at(-1)!.data).requests).toHaveLength(1);
  });

  test("real redactor removes planted PII before write", () => {
    const fs = fakeFs();
    const store = createCaptureStore({ sessionId: "s2", outputFile: "/tmp/s2.json", fs });

    store.record(
      turn({
        request: {
          model: "claude-opus-4-7",
          messages: [{ role: "user", content: "email me at alice@example.com" }],
          system: "user phone 415-555-1234",
          max_tokens: 64,
        },
        response: { id: "msg_2", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" },
      }),
    );

    const written = fs.writes.at(-1)!.data;
    expect(written).toContain("[REDACTED:email]");
    expect(written).toContain("[REDACTED:phone-us]");
    expect(written).not.toContain("alice@example.com");
    expect(written).not.toContain("415-555-1234");
  });
});

describe("capture store — FAIL-CLOSED (AC-S15-2a-2.2)", () => {
  test("redactor throw drops the turn, writes NO unredacted content, continues", () => {
    const fs = fakeFs();
    const onError = vi.fn();
    let shouldThrow = true;
    const store = createCaptureStore({
      sessionId: "s3",
      outputFile: "/tmp/s3.json",
      fs,
      onError,
      redact: (v: unknown) => {
        if (shouldThrow) throw new Error("synthetic redactor failure");
        return v; // pass-through once we flip the flag
      },
    });

    const dropped = store.record(
      turn({
        request: {
          model: "claude-opus-4-7",
          messages: [{ role: "user", content: "SENSITIVE-MARKER-XYZ" }],
          max_tokens: 64,
        },
      }),
    );

    expect(dropped).toBe(false);
    const s = store.getSession();
    expect(s.dropped_turns).toBe(1);
    expect(s.requests).toHaveLength(0);
    expect(s.total_input_tokens).toBe(0); // dropped turn must not touch totals

    // No write may contain the dropped turn's content.
    for (const w of fs.writes) expect(w.data).not.toContain("SENSITIVE-MARKER-XYZ");

    // stderr cites the AC + the turn number.
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toMatch(/AC-S15-2a-2\.2/);
    expect(onError.mock.calls[0]![0]).toMatch(/Turn 1/);

    // Subsequent turns still record once the failure clears (proxy stays up).
    shouldThrow = false;
    const ok = store.record(turn({ request: { model: "m", messages: [{ role: "user", content: "ok now" }], max_tokens: 8 } }));
    expect(ok).toBe(true);
    expect(store.getSession().requests).toHaveLength(1);
    expect(store.getSession().total_turns).toBe(2); // counts both intercepted requests
  });
});

describe("capture store — honesty + lifecycle", () => {
  test("token_count_method=estimated is preserved (never silently exact)", () => {
    const fs = fakeFs();
    const store = createCaptureStore({ sessionId: "s4", outputFile: "/tmp/s4.json", fs });
    store.record(turn({ tokenCountMethod: "estimated" }));
    expect(store.getSession().requests[0]!.token_counts.token_count_method).toBe("estimated");
  });

  test("end() sets ended_at and flushes", () => {
    const fs = fakeFs();
    const store = createCaptureStore({
      sessionId: "s5",
      outputFile: "/tmp/s5.json",
      fs,
      now: () => "2026-05-29T01:02:03.000Z",
    });
    store.end();
    expect(store.getSession().ended_at).toBe("2026-05-29T01:02:03.000Z");
    expect(JSON.parse(fs.writes.at(-1)!.data).ended_at).toBe("2026-05-29T01:02:03.000Z");
  });
});
