// Unit tests for the LoCoMo Tier-A loader (pure — no model, no API). Driven by
// an INLINE synthetic sample so CI never depends on the CC-BY-NC corpus (which
// is gitignored per ADR-0014). A separate, guarded block validates the REAL
// locomo10.json only when it is present locally.

import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLocomo,
  parseLocomoDateTime,
  resolveEvidence,
  sampleQuestions,
  renderTurns,
  type LocomoConversation,
} from "../../evals/harness/locomo";

// A miniature LoCoMo-shaped sample. session_10 is intentionally numbered out of
// lexical order (after session_2) and dated LATER, to prove numeric session sort.
const SYNTH = JSON.stringify([
  {
    sample_id: "conv-test",
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: [
        { speaker: "Alice", dia_id: "D1:1", text: "I adopted a cat named Pixel." },
        { speaker: "Bob", dia_id: "D1:2", text: "Nice!", blip_caption: "a grey tabby cat" },
        { speaker: "Alice", dia_id: "D1:3", text: "" }, // content-free → skipped
      ],
      session_2_date_time: "9:00 am on 9 May, 2023",
      session_2: [{ speaker: "Bob", dia_id: "D2:1", text: "How is Pixel?" }],
      session_10_date_time: "10:00 am on 30 May, 2023",
      session_10: [{ speaker: "Alice", dia_id: "D10:1", text: "Pixel is great." }],
    },
    qa: [
      { question: "What is the cat's name?", answer: "Pixel", evidence: ["D1:1"], category: 4 },
      { question: "What did Bob see in the photo?", answer: "a grey tabby cat", evidence: ["D1:2"], category: 1 },
      { question: "Temporal q", answer: "8 May 2023", evidence: ["D2:1"], category: 2 },
      { question: "Unanswerable adversarial", answer: "No information available", evidence: [], category: 5 },
      { question: "Dangling evidence", answer: "x", evidence: ["D99:9"], category: 4 },
    ],
  },
]);

describe("parseLocomoDateTime", () => {
  test("parses am/pm into UTC seconds", () => {
    // 1:56 pm UTC on 8 May 2023.
    expect(parseLocomoDateTime("1:56 pm on 8 May, 2023")).toBe(Math.floor(Date.UTC(2023, 4, 8, 13, 56, 0) / 1000));
    // 12 pm = noon, 12 am = midnight.
    expect(parseLocomoDateTime("12:00 pm on 1 Jan, 2024")).toBe(Math.floor(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000));
    expect(parseLocomoDateTime("12:30 am on 1 Jan, 2024")).toBe(Math.floor(Date.UTC(2024, 0, 1, 0, 30, 0) / 1000));
  });

  test("two later sessions yield later timestamps", () => {
    const t1 = parseLocomoDateTime("1:56 pm on 8 May, 2023");
    const t2 = parseLocomoDateTime("9:00 am on 9 May, 2023");
    expect(t2).toBeGreaterThan(t1);
  });

  test("throws (never fabricates) on garbage", () => {
    expect(() => parseLocomoDateTime("sometime last week")).toThrow(/unparseable/);
    expect(() => parseLocomoDateTime("1:00 pm on 8 Smarch, 2023")).toThrow(/unknown month/);
  });
});

describe("parseLocomo", () => {
  const [conv] = parseLocomo(SYNTH) as [LocomoConversation];

  test("sessions are ordered numerically (session_10 after session_2)", () => {
    expect(conv!.turns.map((t) => t.sessionIndex)).toEqual([1, 1, 2, 10]);
    // timestamps strictly increase across the chronological turn list.
    for (let i = 1; i < conv!.turns.length; i++) {
      expect(conv!.turns[i]!.timestampSeconds).toBeGreaterThan(conv!.turns[i - 1]!.timestampSeconds);
    }
  });

  test("content-free turn skipped; blip_caption appended", () => {
    expect(conv!.turns).toHaveLength(4); // D1:3 (empty) dropped
    expect(conv!.diaIndex.has("D1:3")).toBe(false);
    const photo = conv!.turns[1]!;
    expect(photo.diaId).toBe("D1:2");
    expect(photo.text).toContain("[shared a photo: a grey tabby cat]");
  });

  test("diaIndex maps ids to chronological turn indices", () => {
    expect(conv!.diaIndex.get("D1:1")).toBe(0);
    expect(conv!.diaIndex.get("D10:1")).toBe(3);
  });

  test("qa coerced; numeric/empty answers handled", () => {
    expect(conv!.questions).toHaveLength(5);
    expect(conv!.questions[0]!.goldenAnswer).toBe("Pixel");
  });
});

describe("resolveEvidence", () => {
  const [conv] = parseLocomo(SYNTH) as [LocomoConversation];
  test("resolves present ids and reports dangling ones", () => {
    const ok = resolveEvidence(conv!, conv!.questions[0]!);
    expect(ok.indices).toEqual([0]);
    expect(ok.unresolved).toEqual([]);
    const dangling = resolveEvidence(conv!, conv!.questions[4]!);
    expect(dangling.indices).toEqual([]);
    expect(dangling.unresolved).toEqual(["D99:9"]);
  });
});

describe("sampleQuestions", () => {
  const [conv] = parseLocomo(SYNTH) as [LocomoConversation];

  test("excludes cat-5 + unresolvable evidence by default", () => {
    const s = sampleQuestions(conv!, { maxQuestions: 10 });
    const cats = s.map((q) => q.category);
    expect(cats).not.toContain(5); // adversarial excluded
    expect(s.find((q) => q.evidence.includes("D99:9"))).toBeUndefined(); // dangling excluded
    expect(s).toHaveLength(3); // the 3 answerable, resolvable questions (cats 4,1,2)
  });

  test("is deterministic + respects maxQuestions", () => {
    const a = sampleQuestions(conv!, { maxQuestions: 2 });
    const b = sampleQuestions(conv!, { maxQuestions: 2 });
    expect(a).toHaveLength(2);
    expect(a.map((q) => q.query)).toEqual(b.map((q) => q.query)); // reproducible
  });

  test("category filter can be overridden", () => {
    const onlyTemporal = sampleQuestions(conv!, { maxQuestions: 10, categories: [2] });
    expect(onlyTemporal.every((q) => q.category === 2)).toBe(true);
  });
});

describe("renderTurns", () => {
  const [conv] = parseLocomo(SYNTH) as [LocomoConversation];
  test("renders Speaker: text, optionally a subset", () => {
    expect(renderTurns(conv!.turns, [0])).toBe("Alice: I adopted a cat named Pixel.");
    expect(renderTurns(conv!.turns).split("\n")).toHaveLength(4);
  });
});

// Guarded: validate the REAL corpus only when present (it is gitignored).
const REAL = join(process.cwd(), "evals", "datasets", "locomo", "locomo10.json");
describe.skipIf(!existsSync(REAL))("real locomo10.json integrity", () => {
  test("parses 10 conversations, each with turns + resolvable evidence", () => {
    const convs = parseLocomo(readFileSync(REAL, "utf8"));
    expect(convs.length).toBe(10);
    for (const c of convs) {
      expect(c.turns.length).toBeGreaterThan(100);
      expect(c.questions.length).toBeGreaterThan(0);
      // chronological invariant on the real data.
      for (let i = 1; i < c.turns.length; i++) {
        expect(c.turns[i]!.timestampSeconds).toBeGreaterThanOrEqual(c.turns[i - 1]!.timestampSeconds);
      }
      // the default sample must yield resolvable-evidence questions.
      const sample = sampleQuestions(c, { maxQuestions: 5 });
      expect(sample.length).toBeGreaterThan(0);
      for (const q of sample) expect(resolveEvidence(c, q).unresolved).toEqual([]);
    }
  });
});
