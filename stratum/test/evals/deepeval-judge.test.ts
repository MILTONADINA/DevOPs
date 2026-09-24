import { afterEach, expect, test, vi } from "vitest";
import { createDeepEvalJudge } from "../../evals/harness/deepeval-judge";
import { createSelectedJudge, type LlmCompletion } from "../../evals/harness/metrics";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("Claude release selection requires the project-local Python worker", async () => {
  const original = process.cwd();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(original, ".deepeval-missing-"));
  const completion: LlmCompletion = { complete: vi.fn(async () => "unused") };
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "test-key");
  try {
    process.chdir(dir);
    const judge = createSelectedJudge({ completion, exploratory: false });
    await expect(judge.score({ query: "q", context: "c", answer: "a" })).rejects.toThrow(/DeepEval worker/);
    await judge.close?.();
    expect(completion.complete).not.toHaveBeenCalled();
  } finally {
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local selection retains exploratory scalar judge", () => {
  const completion: LlmCompletion = { complete: vi.fn(async () => "unused") };
  const judge = createSelectedJudge({ completion, exploratory: true });
  expect(judge.close).toBeUndefined();
});

test("DeepEval judge refuses a missing key before starting a worker", () => {
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  expect(() => createDeepEvalJudge()).toThrow(/requires.*KEY/);
});
