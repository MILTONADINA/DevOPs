// Unit tests for the LongMemEval Tier-A loader (pure — no model, no API). Inline
// synthetic record so CI never depends on the (fetched-on-demand, gitignored)
// corpus; a guarded block validates the real oracle file when present locally.

import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLongMemEval,
  parseLongMemDateTime,
  sampleLongMemQuestions,
  renderLongMemTurns,
  type LongMemQuestion,
} from "../../evals/harness/longmemeval";

const SYNTH = JSON.stringify([
  {
    question_id: "q1",
    question_type: "temporal-reasoning",
    question: "What was the first issue with my car?",
    answer: "GPS not working",
    haystack_dates: ["2023/04/10 (Mon) 17:50", "2023/05/01 (Mon) 09:00"],
    haystack_sessions: [
      [
        { role: "user", content: "I just got my car serviced.", has_answer: false },
        { role: "assistant", content: "Nice! Any issues?" },
        { role: "user", content: "The GPS system is not functioning correctly.", has_answer: true },
      ],
      [
        { role: "user", content: "Thinking of a road trip." },
        { role: "assistant", content: "" }, // empty → skipped
      ],
    ],
    answer_session_ids: ["s1"],
  },
  {
    question_id: "q2",
    question_type: "multi-session",
    question: "no-evidence question",
    answer: "x",
    haystack_dates: ["2023/04/10 (Mon) 12:00"],
    haystack_sessions: [[{ role: "user", content: "hi", has_answer: false }]],
  },
]);

describe("parseLongMemDateTime", () => {
  test("parses YYYY/MM/DD (Day) HH:MM into UTC seconds", () => {
    expect(parseLongMemDateTime("2023/04/10 (Mon) 17:50")).toBe(Math.floor(Date.UTC(2023, 3, 10, 17, 50, 0) / 1000));
  });
  test("later session date yields a later timestamp", () => {
    expect(parseLongMemDateTime("2023/05/01 (Mon) 09:00")).toBeGreaterThan(parseLongMemDateTime("2023/04/10 (Mon) 17:50"));
  });
  test("throws (never fabricates) on garbage", () => {
    expect(() => parseLongMemDateTime("last tuesday")).toThrow(/unparseable/);
  });
  test("fail-loud on out-of-range fields (review #4)", () => {
    expect(() => parseLongMemDateTime("2023/13/01 (Mon) 17:50")).toThrow(/out-of-range/); // month 13
    expect(() => parseLongMemDateTime("2023/02/31 (Mon) 17:50")).toThrow(/out-of-range/); // 31 Feb → would roll
    expect(() => parseLongMemDateTime("2023/04/10 (Mon) 25:00")).toThrow(/out-of-range/); // hour 25
  });
});

describe("parseLongMemEval", () => {
  const qs = parseLongMemEval(SYNTH) as [LongMemQuestion, LongMemQuestion];
  const [q1] = qs;

  test("flattens sessions chronologically; skips empty-content turns", () => {
    expect(q1!.turns).toHaveLength(4); // 3 in s0 (one assistant kept) + 1 in s1 (empty dropped)
    expect(q1!.turns.map((t) => t.sessionIndex)).toEqual([0, 0, 0, 1]);
    for (let i = 1; i < q1!.turns.length; i++) {
      expect(q1!.turns[i]!.timestampSeconds).toBeGreaterThan(q1!.turns[i - 1]!.timestampSeconds);
    }
  });

  test("turn-level has_answer → evidenceIndices", () => {
    expect(q1!.evidenceIndices).toEqual([2]); // the GPS turn
    expect(q1!.turns[2]!.hasAnswer).toBe(true);
    expect(q1!.goldenAnswer).toBe("GPS not working");
    expect(q1!.questionType).toBe("temporal-reasoning");
  });

  test("fail-loud when a session has no haystack_date (review #5; no 1970-epoch fallback)", () => {
    const rec = JSON.stringify([
      {
        question_id: "q",
        question_type: "x",
        question: "q?",
        answer: "a",
        haystack_dates: ["2023/04/10 (Mon) 12:00"], // only ONE date for TWO sessions
        haystack_sessions: [[{ role: "user", content: "a", has_answer: true }], [{ role: "user", content: "b", has_answer: false }]],
      },
    ]);
    expect(() => parseLongMemEval(rec)).toThrow(/no haystack_date/);
  });
});

describe("sampleLongMemQuestions", () => {
  const qs = parseLongMemEval(SYNTH);

  test("requires evidence by default (drops the no-evidence question)", () => {
    const s = sampleLongMemQuestions(qs, { maxQuestions: 10 });
    expect(s.map((q) => q.questionId)).toEqual(["q1"]);
  });
  test("type filter", () => {
    expect(sampleLongMemQuestions(qs, { maxQuestions: 10, types: ["multi-session"], requireEvidence: false }).map((q) => q.questionId)).toEqual(["q2"]);
  });
  test("deterministic + respects maxQuestions", () => {
    const a = sampleLongMemQuestions(qs, { maxQuestions: 1, requireEvidence: false });
    const b = sampleLongMemQuestions(qs, { maxQuestions: 1, requireEvidence: false });
    expect(a.map((q) => q.questionId)).toEqual(b.map((q) => q.questionId));
  });
  test("endpoint-inclusive spread: includes first AND last over a larger set (review #3)", () => {
    const mk = (id: string): LongMemQuestion => ({ questionId: id, questionType: "multi-session", query: "q", goldenAnswer: "a", turns: [{ role: "user", text: "t", timestampSeconds: 1, sessionIndex: 0, hasAnswer: true }], evidenceIndices: [0] });
    const picked = sampleLongMemQuestions([mk("q00"), mk("q01"), mk("q02"), mk("q03")], { maxQuestions: 2 }).map((q) => q.questionId);
    expect(picked).toEqual(["q00", "q03"]); // first + LAST (the old floor-stride gave q00,q02 — dropped q03)
  });
});

describe("renderLongMemTurns", () => {
  const [q1] = parseLongMemEval(SYNTH) as [LongMemQuestion];
  test("renders role: text, optionally a subset", () => {
    expect(renderLongMemTurns(q1!.turns, [2])).toBe("user: The GPS system is not functioning correctly.");
  });
});

// Guarded: validate the real oracle corpus only when present (gitignored).
const REAL = join(process.cwd(), "evals", "datasets", "longmemeval", "longmemeval_oracle.json");
describe.skipIf(!existsSync(REAL))("real longmemeval_oracle.json integrity", () => {
  test("parses 500 questions, each with turns + resolvable evidence", () => {
    const qs = parseLongMemEval(readFileSync(REAL, "utf8"));
    expect(qs.length).toBe(500);
    let withEvidence = 0;
    for (const q of qs) {
      expect(q.turns.length).toBeGreaterThan(0);
      if (q.evidenceIndices.length > 0) withEvidence++;
      for (const ei of q.evidenceIndices) expect(q.turns[ei]!.hasAnswer).toBe(true);
    }
    // the oracle set is evidence-only, so the vast majority must carry evidence.
    expect(withEvidence).toBeGreaterThan(400);
  });
});
