import { afterEach, expect, test, vi } from "vitest";
import type * as Fs from "node:fs";
import { join } from "node:path";
import { main as runLocomo } from "../../scripts/eval-locomo";
import { main as runLongMemEval } from "../../scripts/eval-longmemeval";

const originalCwd = process.cwd();
let fixtureDir: string | undefined;
let realFs: typeof Fs;

afterEach(() => {
  process.chdir(originalCwd);
  if (fixtureDir) realFs.rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixturePath(dataset: string, filename: string): Promise<string> {
  realFs = await vi.importActual<typeof Fs>("node:fs");
  fixtureDir = realFs.mkdtempSync(join(originalCwd, ".eval-zero-"));
  const dir = join(fixtureDir, "evals", "datasets", dataset);
  realFs.mkdirSync(dir, { recursive: true });
  process.chdir(fixtureDir);
  vi.stubEnv("EVAL_LOCAL_BASE_URL", "http://127.0.0.1:1234/v1");
  vi.stubEnv("EVAL_LOCAL_MODEL", "local/fake");
  vi.stubEnv("EVAL_ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  return join(dir, filename);
}

test("LoCoMo exits nonzero when a category filter selects no question", async () => {
  const path = await fixturePath("locomo", "locomo10.json");
  realFs.writeFileSync(
    path,
    JSON.stringify([
      {
        sample_id: "conv-inline",
        conversation: {
          speaker_a: "A",
          speaker_b: "B",
          session_1_date_time: "1:00 pm on 8 May, 2023",
          session_1: [{ speaker: "A", dia_id: "D1:1", text: "The answer is Pixel." }],
        },
        qa: [{ question: "What is the answer?", answer: "Pixel", evidence: ["D1:1"], category: 4 }],
      },
    ]),
  );
  expect(realFs.existsSync(path)).toBe(true);
  expect(realFs.existsSync(join(process.cwd(), "evals", "datasets", "locomo", "locomo10.json"))).toBe(true);
  vi.stubEnv("LOCOMO_CATEGORIES", "9");
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await runLocomo()).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

test("LongMemEval exits nonzero when a type filter selects no question", async () => {
  const path = await fixturePath("longmemeval", "longmemeval_s.json");
  realFs.writeFileSync(
    path,
    JSON.stringify([
      {
        question_id: "q-inline",
        question_type: "single-session-user",
        question: "What was the answer?",
        answer: "Pixel",
        haystack_dates: ["2023/04/10 (Mon) 17:50"],
        haystack_sessions: [[{ role: "user", content: "The answer is Pixel.", has_answer: true }]],
      },
    ]),
  );
  expect(realFs.existsSync(path)).toBe(true);
  expect(realFs.existsSync(join(process.cwd(), "evals", "datasets", "longmemeval", "longmemeval_s.json"))).toBe(true);
  vi.stubEnv("LONGMEMEVAL_TYPES", "absent-type");
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await runLongMemEval()).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

test("LongMemEval exits nonzero when every selected question is too short to score", async () => {
  const path = await fixturePath("longmemeval", "longmemeval_s.json");
  realFs.writeFileSync(
    path,
    JSON.stringify([
      {
        question_id: "q-short",
        question_type: "single-session-user",
        question: "What was the answer?",
        answer: "Pixel",
        haystack_dates: ["2023/04/10 (Mon) 17:50"],
        haystack_sessions: [[{ role: "user", content: "The answer is Pixel.", has_answer: true }]],
      },
    ]),
  );
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await runLongMemEval()).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
