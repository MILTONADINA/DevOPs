import { expect, test } from "vitest";
import { planFullLocomo, planFullLongMemEval } from "../../evals/harness/published-coverage";
import type { LocomoConversation } from "../../evals/harness/locomo";
import type { LongMemQuestion } from "../../evals/harness/longmemeval";
import { runQuestion } from "../../scripts/eval-locomo";

function locomoCorpus(): LocomoConversation[] {
  return Array.from({ length: 10 }, (_, sample) => ({
    sampleId: `conv-${sample}`,
    speakerA: "A",
    speakerB: "B",
    turns: [{ diaId: "D1:1", speaker: "A", text: "answer", timestampSeconds: 1, sessionIndex: 1 }],
    diaIndex: new Map([["D1:1", 0]]),
    questions: Array.from({ length: 154 }, (_, i) => ({
      query: `question-${sample}-${i}`,
      goldenAnswer: "answer",
      evidence: sample === 0 && i === 0 ? ["D99:1"] : ["D1:1"],
      category: 4,
    })),
  }));
}

function longMemCorpus(): LongMemQuestion[] {
  return Array.from({ length: 500 }, (_, i) => ({
    questionId: `q-${i}`,
    questionType: "single-session-user",
    query: `question-${i}`,
    goldenAnswer: "answer",
    turns: [
      { role: "user", text: "answer", timestampSeconds: 1, sessionIndex: 0, hasAnswer: i !== 0 },
      { role: "assistant", text: "okay", timestampSeconds: 2, sessionIndex: 0, hasAnswer: false },
    ],
    evidenceIndices: i === 0 ? [] : [0],
  }));
}

test("full LoCoMo plan judges every answerable question and counts unresolved evidence", () => {
  const result = planFullLocomo(locomoCorpus());
  expect(result.selected).toBe(1540);
  expect(result.labeled).toBe(1539);
  expect(result.unlabeled).toBe(1);
  expect(result.plan.reduce((sum, row) => sum + row.qs.length, 0)).toBe(1540);
  expect(() => planFullLocomo(locomoCorpus().slice(0, 9))).toThrow(/10 conversations/);
  const partial = locomoCorpus();
  partial[0]!.questions.pop();
  expect(() => planFullLocomo(partial)).toThrow(/1540 answerable/);
});

test("full LongMemEval plan judges all 500 questions and counts missing evidence", () => {
  const result = planFullLongMemEval(longMemCorpus());
  expect(result.selected).toBe(500);
  expect(result.labeled).toBe(499);
  expect(result.unlabeled).toBe(1);
  expect(result.questions).toHaveLength(500);
  expect(() => planFullLongMemEval(longMemCorpus().slice(0, 499))).toThrow(/500 questions/);
});

test("a LoCoMo question with dangling gold evidence still receives judged scores without invented survival", async () => {
  const conv = locomoCorpus()[0]!;
  const outcome = await runQuestion(
    conv,
    conv.questions[0]!,
    Float32Array.from([1, 0]),
    [Float32Array.from([1, 0])],
    3600,
    [0.97],
    { generate: async () => "answer" },
    { score: async () => ({ faithfulness: 1, answerRelevancy: 1 }) },
  );
  expect(outcome.byLambda[0]?.evidenceSurvival).toBeUndefined();
  expect(outcome.byLambda[0]?.pruned.faithfulness).toBe(1);
});
