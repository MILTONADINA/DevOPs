import { resolveEvidence, sampleQuestions, type LocomoConversation, type LocomoQuestion } from "./locomo";
import { sampleLongMemQuestions, type LongMemQuestion } from "./longmemeval";

export function planFullLocomo(conversations: LocomoConversation[]): {
  plan: { c: LocomoConversation; qs: LocomoQuestion[] }[];
  selected: number;
  labeled: number;
  unlabeled: number;
} {
  if (conversations.length !== 10 || new Set(conversations.map((c) => c.sampleId)).size !== 10) {
    throw new Error("full LoCoMo requires 10 conversations with distinct IDs");
  }
  const plan = conversations.map((c) => ({
    c,
    qs: sampleQuestions(c, { maxQuestions: Number.MAX_SAFE_INTEGER, categories: [1, 2, 3, 4], requireResolvableEvidence: false }),
  }));
  const selected = plan.reduce((sum, row) => sum + row.qs.length, 0);
  if (selected !== 1540) throw new Error(`full LoCoMo requires 1540 answerable questions; found ${selected}`);
  const labeled = plan.reduce(
    (sum, { c, qs }) =>
      sum +
      qs.filter((q) => {
        const evidence = resolveEvidence(c, q);
        return q.evidence.length > 0 && evidence.indices.length > 0 && evidence.unresolved.length === 0;
      }).length,
    0,
  );
  return { plan, selected, labeled, unlabeled: selected - labeled };
}

export function planFullLongMemEval(input: LongMemQuestion[]): {
  questions: LongMemQuestion[];
  selected: number;
  labeled: number;
  unlabeled: number;
} {
  if (input.length !== 500 || new Set(input.map((q) => q.questionId)).size !== 500) {
    throw new Error("full LongMemEval requires 500 questions with distinct IDs");
  }
  const questions = sampleLongMemQuestions(input, { maxQuestions: Number.MAX_SAFE_INTEGER, requireEvidence: false });
  if (questions.length !== 500 || questions.some((q) => q.turns.length < 2)) {
    throw new Error("full LongMemEval requires 500 nonempty questions with at least two turns");
  }
  const labeled = questions.filter((q) => q.evidenceIndices.length > 0).length;
  return { questions, selected: questions.length, labeled, unlabeled: questions.length - labeled };
}
