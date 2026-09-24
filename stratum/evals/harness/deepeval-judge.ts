/** Persistent project-local Python DeepEval bridge for Claude release gates. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Judge } from "./metrics";
import type { MetricScores } from "./types";

export interface DeepEvalJudge extends Judge {
  close(): Promise<void>;
}

export function createDeepEvalJudge(apiKey = process.env["EVAL_ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_API_KEY"], timeoutMs = 600_000): DeepEvalJudge {
  if (!apiKey) throw new Error("DeepEval release judge requires EVAL_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY");
  const python = join(process.cwd(), ".venv", "bin", "python");
  const script = join(process.cwd(), "evals", "harness", "deepeval_worker.py");
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let workerDone = false;
  const pending: Array<{ resolve: (scores: MetricScores) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }> = [];
  const fail = (error: Error): void => {
    while (pending.length) {
      const next = pending.shift()!;
      if (next.timer) clearTimeout(next.timer);
      next.reject(error);
    }
  };
  const armHead = (): void => {
    const head = pending[0];
    if (!head || head.timer) return;
    head.timer = setTimeout(() => {
      closed = true;
      fail(new Error(`DeepEval worker timed out after ${timeoutMs} ms`));
      child?.kill("SIGKILL");
    }, timeoutMs);
  };
  const start = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    const processHandle = spawn(python, [script], {
      cwd: process.cwd(),
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey, DEEPEVAL_DISABLE_DOTENV: "1", DEEPEVAL_TELEMETRY_OPT_OUT: "YES" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = processHandle;
    processHandle.stderr.on("data", () => {
      /* Protocol errors come through stdout or process exit. */
    });
    processHandle.on("error", (error) => {
      closed = true;
      fail(new Error(`DeepEval worker failed: ${error.message}`));
    });
    processHandle.on("close", (code) => {
      workerDone = true;
      closed = true;
      fail(new Error(`DeepEval worker exited with code ${code}`));
    });
    createInterface({ input: processHandle.stdout }).on("line", (line) => {
      const next = pending.shift();
      if (!next) return;
      if (next.timer) clearTimeout(next.timer);
      try {
        const reply: unknown = JSON.parse(line);
        const value = reply as { ok?: unknown; scores?: Partial<MetricScores>; error?: unknown };
        if (value.ok !== true) throw new Error(`DeepEval metric failed: ${String(value.error ?? "unknown error")}`);
        const scores = value.scores;
        if (!scores || ![scores.faithfulness, scores.answerRelevancy].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
          throw new Error("DeepEval worker returned invalid scores");
        }
        next.resolve(scores as MetricScores);
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
      armHead();
    });
    return processHandle;
  };
  return {
    score(input): Promise<MetricScores> {
      if (closed) return Promise.reject(new Error("DeepEval judge is closed"));
      const worker = start();
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        armHead();
        worker.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
          if (error) fail(new Error(`DeepEval worker write failed: ${error.message}`));
        });
      });
    },
    async close(): Promise<void> {
      closed = true;
      if (!child) return;
      const worker = child;
      if (workerDone || worker.exitCode !== null || worker.signalCode !== null) return;
      if (pending.length) {
        fail(new Error("DeepEval judge closed with pending scores"));
        worker.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => {
        worker.once("close", () => resolve());
        if (!worker.killed) worker.stdin.end();
      });
    },
  };
}
