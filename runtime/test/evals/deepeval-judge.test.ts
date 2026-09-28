import { afterEach, expect, test, vi } from "vitest";
import { createDeepEvalJudge } from "../../evals/harness/deepeval-judge";
import { createSelectedJudge, type LlmCompletion } from "../../evals/harness/metrics";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("Claude release selection requires the project-local Python worker", async () => {
  const original = process.cwd();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
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

test("a silent worker times out, exits, and refuses later scores", async () => {
  const original = process.cwd();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(original, ".deepeval-silent-"));
  const bin = path.join(dir, ".venv", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\nexec sleep 2\n", { mode: 0o700 });
  let judge: ReturnType<typeof createDeepEvalJudge> | undefined;
  try {
    process.chdir(dir);
    expect(process.cwd()).toBe(dir);
    expect(fs.existsSync(path.join(process.cwd(), ".venv", "bin", "python"))).toBe(true);
    fs.accessSync(path.join(process.cwd(), ".venv", "bin", "python"), fs.constants.X_OK);
    judge = createDeepEvalJudge("test-key", 50);
    const first = judge.score({ query: "q", context: "c", answer: "a" });
    const queued = judge.score({ query: "q2", context: "c2", answer: "a2" });
    const results = Promise.allSettled([first, queued]);
    let observationTimer: NodeJS.Timeout | undefined;
    try {
      const settled = await Promise.race([
        results,
        new Promise<never>((_, reject) => {
          observationTimer = setTimeout(() => reject(new Error("test observation expired")), 500);
        }),
      ]);
      expect(settled).toHaveLength(2);
      for (const result of settled) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toMatchObject({ message: expect.stringMatching(/timed out/) });
      }
    } finally {
      if (observationTimer) clearTimeout(observationTimer);
    }
    await expect(judge.score({ query: "q", context: "c", answer: "a" })).rejects.toThrow(/closed/);
    await expect(Promise.race([judge.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("worker did not exit")), 500))])).resolves.toBeUndefined();
  } finally {
    await judge?.close();
    process.chdir(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
